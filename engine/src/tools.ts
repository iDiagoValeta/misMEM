import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import {
  CaptureInput,
  RecallInput,
  ConsolidateInput,
  CrystallizeInput,
  ForgetInput,
  ReinforceInput,
  type RecallHit,
} from "./schema.js";
import { contentHash } from "./db.js";
import { excludeNoiseSql } from "./noise.js";
import { plain, searchTerms } from "./terms.js";
import {
  embedTexts,
  loadEmbeddingConfig,
  semanticSearchMemories,
  type EmbedFn,
  type SemanticHit,
} from "./embeddings/index.js";
import {
  decayMemories,
  effectiveSalience,
  reinforceMemories,
  type SalienceRow,
} from "./salience.js";

const now = (): number => Date.now();
const CANDIDATE_POOL_LIMIT = 50;
const MEMORY_FTS_SCAN_LIMIT = 200;
const RRF_K = 60;
// Menor que un puesto de RRF en la cima (1/61 - 1/62 ≈ 0.00026): ahí la saliencia
// sólo desempata. Más abajo los puestos se achican (≈ 0.00008 al final de los 50
// candidatos) y una saliencia alta puede adelantar dos o tres lugares.
const SALIENCE_RRF_WEIGHT = 0.0002;

const quoteFts = (term: string): string => `"${term.replace(/"/g, '""')}"`;

function escapeFts(query: string): string {
  // Cada palabra entre comillas: FTS5 las une con AND y los caracteres especiales no rompen el MATCH.
  // Sin palabras, un término vacío no matchea nada y evita una expresión inválida.
  const escaped = searchTerms(query).map(quoteFts).join(" ");
  return escaped || '""';
}

// El tokenizador no reduce a raíz: sin esto "controlo" no encuentra "controlan" ni "deudas"
// encuentra "deuda". Una palabra de 5 letras o más busca por su principio, sin las últimas
// tres (que es donde cambian género, número y conjugación) y nunca por menos de 4.
const PREFIX_FROM_LENGTH = 5;
const PREFIX_TRIM = 3;
const PREFIX_MIN = 4;

// Cuántos términos informativos distintos tienen que coincidir. Con uno se colaría
// cualquier recuerdo que comparta una palabra rara pero ajena; con dos, el candidato tiene
// que hablar de lo mismo por dos sitios. Las palabras comunes no cuentan.
const RELAXED_MIN_INFORMATIVE = 2;
// En una pregunta larga, dos coincidencias no son prueba aunque sean raras: la proporción
// sube el mínimo con el tamaño de la consulta (tres para diez palabras). Es el mismo 0.3
// del intento anterior, pero contando sólo términos informativos: las palabras comunes ni
// entran ni ordenan.
const RELAXED_MIN_RATIO = 0.3;
// Un término es raro cuando aparece en pocas memorias; los que salen en muchas no
// distinguen una paráfrasis de una casualidad (la idea del IDF de bm25). El suelo de 3
// documentos protege corpus pequeños, donde una fracción sola marcaría casi todo como
// común; la fracción crece con la base para que "pocas" signifique lo mismo en una memoria
// de 300 recuerdos que en una de 3.000. Medido con 311 memorias, 50 prompts con flexión y
// 10 preguntas ajenas: 0,02 rescata 29/50, 0,05 rescata 41/50 y 0,10 ya trae 2 ajenas.
// 0,05 deja el doble de margen hasta la primera ajena.
const RELAXED_RARE_MIN_DOCS = 3;
const RELAXED_RARE_FRACTION = 0.05;
// Una consulta de una sola palabra no puede juntar dos coincidencias, así que se rescata
// con la única informativa. Se exige cuerpo suficiente para que el prefijo identifique
// algo: "deudas" sí, "red" no.
const RELAXED_SINGLE_MIN_LETTERS = 5;
// El rescate es un último recurso, no una segunda lista: tres recuerdos bastan para
// recuperar la paráfrasis y no convierten la respuesta en un volcado.
const RELAXED_MAX_RESULTS = 3;
// Tope de palabras para que la consulta de rescate no crezca sin límite.
const RELAXED_MAX_TERMS = 12;

interface RelaxedTerm {
  word: string;
  /** Principio por el que se busca; null si la palabra es demasiado corta y va exacta. */
  prefix: string | null;
}

/**
 * Las palabras del rescate, ya normalizadas y sin repetir. La raíz aproximada sale de los
 * mismos constantes que la búsqueda por prefijo: quitar las últimas tres letras es donde
 * cambian género, número y conjugación.
 */
function relaxedTerms(query: string): RelaxedTerm[] {
  const seen = new Set<string>();
  const terms: RelaxedTerm[] = [];
  for (const term of searchTerms(query)) {
    const word = plain(term);
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push({
      word,
      prefix:
        word.length < PREFIX_FROM_LENGTH
          ? null
          : word.slice(0, Math.max(PREFIX_MIN, word.length - PREFIX_TRIM)),
    });
    if (terms.length === RELAXED_MAX_TERMS) break;
  }
  return terms;
}

/**
 * La consulta de rescate cuando la estricta no encontró nada: una sola expresión con OR de
 * todas las palabras. FTS5 ya no decide si el recuerdo vale; sólo trae candidatos baratos.
 */
function relaxedFts(terms: RelaxedTerm[]): string {
  const expressions = terms.map(({ word, prefix }) =>
    prefix ? `${quoteFts(prefix)}*` : quoteFts(word),
  );
  return expressions.join(" OR ") || '""';
}

/**
 * En cuántas memorias distintas aparece el término, con el mismo prefijo que usa el
 * rescate. Se mide sobre `memories_fts` y no sobre la capa que se rescata: las memorias
 * son el corpus consolidado donde se acumula el vocabulario genérico, mientras rasgos y
 * episodios son dispersos y ahí casi todo parecería raro. Cuenta sin filtrar por scope
 * porque el vocabulario es de la persona, no del proyecto, y así el umbral no cambia de
 * una memoria pequeña a otra grande.
 */
function documentFrequency(db: DB, term: RelaxedTerm): number {
  const q = term.prefix ? `${quoteFts(term.prefix)}*` : quoteFts(term.word);
  const row = db
    .prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
    .get(q) as { n: number };
  return row.n;
}

/**
 * Los términos que distinguen dentro de este corpus. Un término ausente (frecuencia 0)
 * nunca va a coincidir, así que no entra: contarlo sólo subiría el mínimo de
 * coincidencias sin aportar señal y rompería la excepción de la consulta de una palabra.
 *
 * Un término que sale en todas las memorias también entra: con el corpus diminuto de un
 * test o de una instalación recién nacida, "todos los documentos" no es ruido sino el
 * tema del que hablan, y el IDF no tiene resolución para distinguirlo. En un corpus
 * grande, que una palabra ajena a la consulta aparezca en todas las memorias es
 * improbable; si aparece, es el tema y merece contar.
 */
function informativeTerms(db: DB, terms: RelaxedTerm[]): RelaxedTerm[] {
  const total = (db.prepare("SELECT count(*) AS n FROM memories_fts").get() as { n: number }).n;
  const rare = Math.max(RELAXED_RARE_MIN_DOCS, Math.ceil(total * RELAXED_RARE_FRACTION));
  return terms.filter((term) => {
    const frequency = documentFrequency(db, term);
    return frequency > 0 && (frequency <= rare || frequency === total);
  });
}

/**
 * Cuántos términos informativos distintos de la consulta aparecen en el texto, contando
 * por el mismo prefijo con el que se buscó. Las palabras comunes no entran en la cuenta:
 * coincidir en "sistema" en una pregunta sobre planetas no prueba nada.
 */
function countRelaxedMatches(text: string, terms: RelaxedTerm[]): number {
  const tokens = plain(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  return terms.reduce((count, { word, prefix }) => {
    const found = tokens.some((token) => (prefix ? token.startsWith(prefix) : token === word));
    return found ? count + 1 : count;
  }, 0);
}

export function capture(db: DB, raw: unknown): { id: string; deduped: boolean } {
  const input = CaptureInput.parse(raw);
  const hash = contentHash(input.body);

  // Idéntico (scope, body) ya inscripto → no duplicar; re-ingestar es idempotente.
  const existing = db
    .prepare(
      "SELECT id FROM episodes WHERE scope = ? AND content_hash = ? LIMIT 1",
    )
    .get(input.scope, hash) as { id: string } | undefined;
  if (existing) return { id: existing.id, deduped: true };

  const id = ulid();
  db.prepare(
    "INSERT INTO episodes (id, scope, body, created_at, content_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.scope, input.body, now(), hash);
  return { id, deduped: false };
}

/**
 * Reforzar lo que el recall devuelve premia a un recuerdo que aparece siempre y no sirve
 * nunca. Con el hook del cliente puesto, el refuerzo llega por `reinforce` y esto se apaga.
 */
function reinforcesOnRecall(): boolean {
  return (process.env.MISMEM_REINFORCE_ON_RECALL ?? "on").trim().toLowerCase() !== "off";
}

export interface RecallOptions {
  reinforce?: boolean;
  at?: number;
  embeddingModel?: string;
}

interface TraitCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

interface MemoryCandidate extends SalienceRow {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  fts_rank: number;
}

interface EpisodeCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

/** Lo mínimo para ordenar candidatos rescatados: texto, id y puesto de FTS5. */
interface RankedCandidate {
  id: string;
  text: string;
  fts_rank: number;
}

type TraitRow = TraitCandidate & { fts_rank: number };
type EpisodeRow = EpisodeCandidate & { fts_rank: number };

/**
 * Deja sólo los candidatos del rescate que alcanzan el mínimo de términos informativos y
 * los ordena por esas coincidencias, no por la saliencia ni por la antigüedad. El tope
 * evita que el rescate se convierta en una segunda lista.
 */
function relaxRows<T extends RankedCandidate>(
  rows: T[],
  informative: RelaxedTerm[],
  queryTerms: number,
): T[] {
  if (rows.length === 0 || informative.length === 0) return [];
  const only = informative.length === 1 ? informative[0] : undefined;
  // Una sola palabra no puede juntar dos coincidencias; si es corta, el prefijo
  // identificaría demasiado y no se rescata.
  const required =
    queryTerms === 1
      ? only && only.word.length >= RELAXED_SINGLE_MIN_LETTERS
        ? 1
        : 0
      : Math.max(RELAXED_MIN_INFORMATIVE, Math.ceil(queryTerms * RELAXED_MIN_RATIO));
  // Si no hay tantos términos informativos como exige la consulta, nadie puede llegar.
  if (required === 0 || informative.length < required) return [];
  return rows
    .map((row) => ({ row, matches: countRelaxedMatches(row.text, informative) }))
    .filter(({ matches }) => matches >= required)
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        Number(a.row.fts_rank) - Number(b.row.fts_rank) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, RELAXED_MAX_RESULTS)
    .map(({ row }) => row);
}

function lexicalCandidates(
  db: DB,
  input: ReturnType<typeof RecallInput.parse>,
  at: number,
): {
  traits: TraitCandidate[];
  memories: RecallHit[];
  episodes: EpisodeCandidate[];
  /** Ids que sólo llegaron por el rescate; con embeddings deben pasar también el corte. */
  relaxedMemoryIds: Set<string>;
} {
  const strict = escapeFts(input.query);
  const scopeFilter = input.scope ? "AND t.scope = @scope" : "";

  const traitStmt = db.prepare(
    `SELECT t.id, t.scope, t.name AS text, t.created_at, rank AS fts_rank
     FROM traits_fts f JOIN traits t ON t.rowid = f.rowid
     WHERE traits_fts MATCH @q ${scopeFilter}
     ORDER BY rank, t.id LIMIT @limit`,
  );

  const memoryStmt = db.prepare(
    `SELECT m.id, m.scope, m.gist AS text, m.salience, m.created_at,
            m.last_accessed_at, m.salience_updated_at, rank AS fts_rank
     FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
     WHERE memories_fts MATCH @q ${input.scope ? "AND m.scope = @scope" : ""}
       AND ${excludeNoiseSql("m")}
     ORDER BY rank, m.salience DESC, m.id LIMIT @limit`,
  );

  const episodeStmt = db.prepare(
    `SELECT e.id, e.scope, e.body AS text, e.created_at, rank AS fts_rank
     FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
     WHERE episodes_fts MATCH @q ${input.scope ? "AND e.scope = @scope" : ""}
       AND e.consolidated_into IS NULL
     ORDER BY e.created_at DESC, e.id LIMIT @limit`,
  );

  const run = (q: string): {
    traits: TraitRow[];
    memories: MemoryCandidate[];
    episodes: EpisodeRow[];
  } => ({
    traits: traitStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as TraitRow[],
    memories: memoryStmt.all({
      q,
      scope: input.scope,
      limit: MEMORY_FTS_SCAN_LIMIT,
    }) as MemoryCandidate[],
    episodes: episodeStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as EpisodeRow[],
  });

  // La estricta manda sobre la consulta entera: si encontró algo en cualquier capa, el
  // resultado es el de siempre. El rescate sólo entra cuando no hubo ni un candidato, para
  // que una paráfrasis no altere una búsqueda que ya funcionaba.
  const strictRows = run(strict);
  const strictEmpty =
    strictRows.traits.length === 0 &&
    strictRows.memories.length === 0 &&
    strictRows.episodes.length === 0;
  // Sólo se consulta la frecuencia cuando de verdad hace falta rescatar: son hasta doce
  // cuentas sobre memories_fts que una búsqueda normal no debe pagar.
  let rescuedTerms: RelaxedTerm[] | null = null;
  let rescuedTermCount = 0;
  let rows = strictRows;
  if (strictEmpty) {
    const terms = relaxedTerms(input.query);
    const relaxed = relaxedFts(terms);
    if (relaxed !== strict) {
      rows = run(relaxed);
      rescuedTerms = informativeTerms(db, terms);
      rescuedTermCount = terms.length;
    }
  }
  const rescued = rescuedTerms !== null;
  const traitRows: TraitCandidate[] = (
    rescuedTerms
      ? relaxRows(rows.traits, rescuedTerms, rescuedTermCount)
      : rows.traits
  ).map(({ fts_rank: _ftsRank, ...row }) => row);
  const episodeRows: EpisodeCandidate[] = (
    rescuedTerms
      ? relaxRows(rows.episodes, rescuedTerms, rescuedTermCount)
      : rows.episodes
  ).map(({ fts_rank: _ftsRank, ...row }) => row);

  // El rescate ya viene ordenado por coincidencias; el estricto conserva el orden de siempre.
  const orderedMemories =
    rescuedTerms
      ? relaxRows(rows.memories, rescuedTerms, rescuedTermCount)
      : rows.memories.sort(
          (a, b) =>
            Number(a.fts_rank) - Number(b.fts_rank) ||
            (b.salience ?? 0) - (a.salience ?? 0) ||
            a.id.localeCompare(b.id),
        );
  const memories: RecallHit[] = orderedMemories
    .slice(0, rescued ? RELAXED_MAX_RESULTS : CANDIDATE_POOL_LIMIT)
    .map((r) => ({
      layer: "memory" as const,
      id: r.id,
      scope: r.scope,
      text: r.text,
      salience: effectiveSalience(r, at),
      created_at: r.created_at,
    }));

  return {
    traits: traitRows,
    memories,
    episodes: episodeRows,
    relaxedMemoryIds: rescued ? new Set(memories.map((hit) => hit.id)) : new Set<string>(),
  };
}

function finalizeHits(
  db: DB,
  hits: RecallHit[],
  options: RecallOptions,
  at: number,
): { hits: RecallHit[] } {
  if (options.reinforce ?? reinforcesOnRecall()) {
    reinforceMemories(
      db,
      hits.filter((h) => h.layer === "memory").map((h) => h.id),
      { at },
    );
  }

  return { hits };
}

/**
 * Refuerza los recuerdos que una respuesta usó de verdad.
 *
 * Los rasgos se cuentan aparte en vez de caer en `unknown`: la inyección también los
 * adelanta, así que mezclarlos dejaba esa alarma —la de "alguien manda ids inventados"—
 * sonando desde el primer día. Un rasgo gana fuerza al cristalizar, no al usarse.
 */
export function reinforce(
  db: DB,
  raw: unknown,
  options: { at?: number } = {},
): { reinforced: number; traits: number; unknown: number } {
  const input = ReinforceInput.parse(raw);
  const ids = [...new Set(input.memory_ids)];
  const marcadores = ids.map(() => "?").join(", ");
  const existentes = (tabla: string): string[] =>
    (
      db.prepare(`SELECT id FROM ${tabla} WHERE id IN (${marcadores})`).all(...ids) as Array<{
        id: string;
      }>
    ).map((row) => row.id);

  const known = existentes("memories");
  const traits = existentes("traits");

  reinforceMemories(db, known, { at: options.at, boost: input.boost });
  return {
    reinforced: known.length,
    traits: traits.length,
    unknown: ids.length - known.length - traits.length,
  };
}

export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? now();
  const lexical = lexicalCandidates(db, input, at);
  const hits: RecallHit[] = [
    ...lexical.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...lexical.memories,
    ...lexical.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, input.limit);
  return finalizeHits(db, hits, { ...options, reinforce: options.reinforce ?? input.reinforce }, at);
}

function semanticHitToRecall(hit: SemanticHit, at: number): RecallHit {
  return {
    layer: "memory",
    id: hit.id,
    scope: hit.scope,
    text: hit.text,
    salience: effectiveSalience(hit, at),
    created_at: hit.created_at,
    via: "semantic",
  };
}

function fuseMemories(
  lexical: RecallHit[],
  semantic: SemanticHit[],
  at: number,
): RecallHit[] {
  const candidates = new Map<
    string,
    { hit: RecallHit; rrf: number }
  >();

  lexical.forEach((hit, index) => {
    candidates.set(hit.id, {
      hit,
      rrf: 1 / (RRF_K + index + 1),
    });
  });

  semantic.forEach((row, index) => {
    const current = candidates.get(row.id);
    if (current) {
      current.rrf += 1 / (RRF_K + index + 1);
      return;
    }
    candidates.set(row.id, {
      hit: semanticHitToRecall(row, at),
      rrf: 1 / (RRF_K + index + 1),
    });
  });

  return [...candidates.values()]
    .sort((a, b) => {
      const scoreA =
        a.rrf + (a.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      const scoreB =
        b.rrf + (b.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      return (
        scoreB - scoreA ||
        (b.hit.salience ?? 0) - (a.hit.salience ?? 0) ||
        b.hit.created_at - a.hit.created_at ||
        a.hit.id.localeCompare(b.hit.id)
      );
    })
    .map(({ hit }) => hit);
}

/**
 * Recall híbrido: FTS5 (léxico) + coseno sobre embeddings (semántico).
 * Si no hay embedder disponible (Ollama caído / MISMEM_EMBEDDINGS=off),
 * el resultado es idéntico a recall().
 */
export async function recallHybrid(
  db: DB,
  raw: unknown,
  embedFn?: EmbedFn,
  options: RecallOptions = {},
): Promise<{ hits: RecallHit[] }> {
  const input = RecallInput.parse(raw);
  const at = options.at ?? now();
  const lexical = lexicalCandidates(db, input, at);
  const cfg = loadEmbeddingConfig();
  const actualEmbedFn =
    embedFn ?? ((texts: string[]) => embedTexts(texts, cfg, "query"));

  const vecs = await actualEmbedFn([input.query]);
  const queryVec = vecs?.[0];
  const semantic = queryVec
    ? semanticSearchMemories(db, queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore,
        model: options.embeddingModel ?? (embedFn ? undefined : cfg.model),
      })
    : [];
  // Un recuerdo que sólo aparece por el rescate léxico tiene que pasar también el corte
  // semántico: el rescate recupera paráfrasis, pero no debe devolver lo que el significado
  // descartó. `semantic` ya viene filtrado por minScore.
  let memories = lexical.memories;
  if (queryVec) {
    const semanticIds = new Set(semantic.map((hit) => hit.id));
    const confirmed = lexical.memories.filter(
      (hit) => !lexical.relaxedMemoryIds.has(hit.id) || semanticIds.has(hit.id),
    );
    memories = fuseMemories(confirmed, semantic, at);
  }
  const hits: RecallHit[] = [
    ...lexical.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...memories,
    ...lexical.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, input.limit);

  return finalizeHits(db, hits, { ...options, reinforce: options.reinforce ?? input.reinforce }, at);
}

export function consolidate(
  db: DB,
  raw: unknown,
): { memory_id: string; consolidated: number } {
  const input = ConsolidateInput.parse(raw);
  const id = ulid();
  const ts = now();
  const sourceJson = JSON.stringify(input.source_episode_ids);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (
         id, scope, gist, details, source_episode_ids, salience, created_at,
         salience_updated_at
       )
       VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.gist,
      input.details ?? null,
      sourceJson,
      ts,
      ts,
    );

    const placeholders = input.source_episode_ids.map(() => "?").join(",");
    const upd = db.prepare(
      `UPDATE episodes SET consolidated_into = ?
       WHERE id IN (${placeholders}) AND scope = ?`,
    );
    const result = upd.run(id, ...input.source_episode_ids, input.scope);
    return result.changes;
  });

  const consolidated = tx();
  return { memory_id: id, consolidated };
}

export function crystallize(
  db: DB,
  raw: unknown,
): { trait_id: string; created: boolean; strength: number } {
  const input = CrystallizeInput.parse(raw);
  const ts = now();
  const evidenceJson = JSON.stringify(input.evidence_memory_ids);

  const existing = db
    .prepare("SELECT id, strength FROM traits WHERE scope = ? AND name = ?")
    .get(input.scope, input.name) as
    | { id: string; strength: number }
    | undefined;

  if (existing) {
    const newStrength = existing.strength + input.evidence_memory_ids.length;
    db.prepare(
      `UPDATE traits
       SET strength = ?, evidence_memory_ids = ?, polarity = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newStrength, evidenceJson, input.polarity, ts, existing.id);
    return { trait_id: existing.id, created: false, strength: newStrength };
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO traits (id, scope, name, evidence_memory_ids, strength, polarity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.name,
    evidenceJson,
    input.evidence_memory_ids.length,
    input.polarity,
    ts,
    ts,
  );
  return {
    trait_id: id,
    created: true,
    strength: input.evidence_memory_ids.length,
  };
}

export function forget(
  db: DB,
  raw: unknown,
): {
  episodes_to_delete: number;
  memories_to_delete: number;
  dry_run: boolean;
} {
  const input = ForgetInput.parse(raw);
  const at = now();
  const cutoff = at - input.before_days * 86_400_000;
  const memoryCutoff = at - input.memory_grace_days * 86_400_000;
  const scopeWhere = input.scope ? "AND scope = @scope" : "";
  const memoryRows = db
    .prepare(
      `SELECT id, salience, created_at, last_accessed_at, salience_updated_at
       FROM memories
       WHERE created_at <= @memoryCutoff ${scopeWhere}`,
    )
    .all({
      memoryCutoff,
      scope: input.scope,
    }) as Array<SalienceRow & { id: string }>;
  const memoryIds = memoryRows
    .filter(
      (row) => effectiveSalience(row, at) < input.salience_below,
    )
    .map((row) => row.id);

  const episodeIds = new Set(
    (
      db
        .prepare(
          `SELECT id FROM episodes
           WHERE consolidated_into IS NOT NULL
             AND created_at < @cutoff ${scopeWhere}`,
        )
        .all({ cutoff, scope: input.scope }) as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const linkedEpisodes = db.prepare(
    "SELECT id FROM episodes WHERE consolidated_into = ?",
  );
  for (const memoryId of memoryIds) {
    const rows = linkedEpisodes.all(memoryId) as Array<{ id: string }>;
    for (const row of rows) episodeIds.add(row.id);
  }

  if (!input.dry_run) {
    db.transaction(() => {
      decayMemories(db, { scope: input.scope, at });
      const deleteOldEpisodes = db.prepare(
        `DELETE FROM episodes
         WHERE consolidated_into IS NOT NULL
           AND created_at < @cutoff ${scopeWhere}`,
      );
      deleteOldEpisodes.run({ cutoff, scope: input.scope });
      const deleteLinkedEpisodes = db.prepare(
        "DELETE FROM episodes WHERE consolidated_into = ?",
      );
      const deleteMemory = db.prepare("DELETE FROM memories WHERE id = ?");
      for (const memoryId of memoryIds) {
        deleteLinkedEpisodes.run(memoryId);
        deleteMemory.run(memoryId);
      }
    })();
  }

  return {
    episodes_to_delete: episodeIds.size,
    memories_to_delete: memoryIds.length,
    dry_run: input.dry_run,
  };
}
