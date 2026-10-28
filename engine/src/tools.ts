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

// El rescate puntúa con el mismo tokenizador que indexa FTS5 (unicode61): `_` y cualquier
// signo separan palabras. Si un lado parte y el otro no, se recupera por un criterio y se
// cuenta por otro, y el candidato se descarta con cero coincidencias.
const FTS_TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

// Cuántos términos informativos distintos tienen que coincidir. Con uno se colaría
// cualquier recuerdo que comparta una palabra rara pero ajena; con dos, el candidato tiene
// que hablar de lo mismo por dos sitios. Las palabras comunes no cuentan.
const RELAXED_MIN_INFORMATIVE = 2;
// En una pregunta larga, dos coincidencias no son prueba aunque sean raras: la proporción
// sube el mínimo con el tamaño de la consulta. Se mide sobre TODAS las palabras buscadas,
// no sólo las informativas: en un corpus diminuto casi todo sale raro y dos palabras
// comunes bastan para rescatar una pregunta ajena y larga, como comprueba el test de la
// pregunta de astronomía. Con la base informativa el banco de ajenas seguía a cero, pero
// ese caso se colaba. Las informativas siguen mandando en la cuenta de coincidencias y en
// el orden; aquí sólo fijan cuántas hacen falta.
const RELAXED_MIN_RATIO = 0.3;
// Un término es raro cuando aparece en pocas memorias; los que salen en muchas no
// distinguen una paráfrasis de una casualidad (la idea del IDF de bm25). El suelo de 3
// documentos protege corpus pequeños, donde una fracción sola marcaría casi todo como
// común; la fracción crece con la base para que "pocas" signifique lo mismo en una memoria
// de 300 recuerdos que en una de 3.000. Se calibra con `mismem-bench --off-topic` sobre el
// banco privado: se sube la fracción mientras las preguntas ajenas sigan sin traer nada y
// se elige la mayor que las deje a cero, para rescatar el máximo de paráfrasis sin colar
// falsos positivos.
const RELAXED_RARE_MIN_DOCS = 3;
const RELAXED_RARE_FRACTION = 0.05;
// El rescate es un último recurso, no una segunda lista: tres recuerdos bastan para
// recuperar la paráfrasis y no convierten la respuesta en un volcado. Este es el único
// tope del rescate; el estricto conserva el suyo de candidatos.
const RELAXED_MAX_RESULTS = 3;
// Tope de palabras para que la consulta de rescate no crezca sin límite.
const RELAXED_MAX_TERMS = 12;

interface RelaxedTerm {
  word: string;
  /** Principio por el que se busca; null si la palabra es demasiado corta y va exacta. */
  prefix: string | null;
}

interface RelaxedQuery {
  /** Términos que se buscan y se cuentan, ya sin prefijos repetidos. */
  terms: RelaxedTerm[];
  /** Palabras distintas antes de juntar prefijos: dice si la consulta es de una sola. */
  wordCount: number;
}

/**
 * Las palabras del rescate, ya normalizadas y sin repetir. La raíz aproximada sale de los
 * mismos constantes que la búsqueda por prefijo: quitar las últimas tres letras es donde
 * cambian género, número y conjugación. Cada palabra se parte como la parte FTS5, porque
 * un identificador con guion bajo son dos tokens para el índice y uno solo aquí.
 */
function relaxedTerms(query: string): RelaxedQuery {
  const seen = new Set<string>();
  const terms: RelaxedTerm[] = [];
  for (const term of searchTerms(query)) {
    for (const word of plain(term).split(FTS_TOKEN_SPLIT)) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      terms.push({
        word,
        prefix:
          word.length < PREFIX_FROM_LENGTH
            ? null
            : word.slice(0, Math.max(PREFIX_MIN, word.length - PREFIX_TRIM)),
      });
    }
  }
  return {
    terms: dedupeByPrefix(terms).slice(0, RELAXED_MAX_TERMS),
    wordCount: terms.length,
  };
}

/**
 * Junta los términos que buscan por el mismo principio: `decidir` (`deci`) y `decision`
 * (`decis`) los satisface el mismo token, así que dejarlos sueltos permitiría cumplir el
 * mínimo de dos coincidencias con una sola palabra. Se queda el prefijo más largo, que es
 * el más específico y el que menos candidatos ajenos arrastra.
 */
function dedupeByPrefix(terms: RelaxedTerm[]): RelaxedTerm[] {
  const kept: RelaxedTerm[] = [];
  const prefixes: string[] = [];
  for (const term of terms) {
    const prefix = term.prefix ?? term.word;
    const clash = prefixes.findIndex(
      (other) => prefix.startsWith(other) || other.startsWith(prefix),
    );
    if (clash === -1) {
      kept.push(term);
      prefixes.push(prefix);
    } else if (prefix.length > (prefixes[clash]?.length ?? 0)) {
      kept[clash] = term;
      prefixes[clash] = prefix;
    }
  }
  return kept;
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
 * rescate. Se mide sobre `memories_fts` (gist + details, el mismo texto que se puntúa) y
 * no sobre la capa que se rescata: las memorias son el corpus consolidado donde se
 * acumula el vocabulario genérico, mientras rasgos y episodios son dispersos y ahí casi
 * todo parecería raro. Ese cero sólo dice que el término no está en las memorias, no que
 * no exista en el recall: rasgos y episodios no viven en esta tabla. Cuenta sin filtrar
 * por scope porque el vocabulario es de la persona, no del proyecto, y así el umbral no
 * cambia de una memoria pequeña a otra grande. El ruido que `forget` conserva no es
 * conocimiento: se excluye igual que en la búsqueda, o empujaría un término real por
 * encima de `rare`.
 */
function documentFrequency(db: DB, term: RelaxedTerm): number {
  const q = term.prefix ? `${quoteFts(term.prefix)}*` : quoteFts(term.word);
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND ${excludeNoiseSql("m")}`,
    )
    .get(q) as { n: number };
  return row.n;
}

/**
 * Los términos que pueden distinguir dentro de este corpus. La frecuencia se mide sólo
 * sobre las memorias, así que un término ausente de ellas sale con 0, el valor más raro
 * posible: no puede casar con ninguna memoria y por eso no altera el rescate de esa capa,
 * pero sí puede casar con un episodio o un rasgo, que no están en `memories_fts`.
 * Descartarlo dejaba esos dos rescates vacíos en cuanto sus palabras no aparecían en
 * ninguna memoria, y con la tabla de memorias vacía pasaba siempre (instalación recién
 * nacida, sin capa semántica), que es justo el caso que el rescate tiene que cubrir.
 * El precio: con pocas memorias casi todo término es informativo, y un episodio que comparta
 * dos raíces con una pregunta ajena ("cambiar la configuración del móvil" frente a la del
 * servidor) se rescata. Es el camino degradado, donde traer algo flojo cuesta menos que no
 * traer nada; con muchas memorias, dos términos ausentes de todas ellas ya son señal.
 *
 * Un término que sale en todas las memorias también entra: con el corpus diminuto de un
 * test o de una instalación recién nacida, "todos los documentos" no es ruido sino el
 * tema del que hablan, y el IDF no tiene resolución para distinguirlo. En un corpus
 * grande, que una palabra ajena a la consulta aparezca en todas las memorias es
 * improbable; si aparece, es el tema y merece contar. El total sale del mismo conjunto
 * que la frecuencia, sin ruido, para que las dos comparaciones hablen del mismo corpus.
 */
function informativeTerms(db: DB, terms: RelaxedTerm[]): RelaxedTerm[] {
  const total = (
    db
      .prepare(
        `SELECT count(*) AS n
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE ${excludeNoiseSql("m")}`,
      )
      .get() as { n: number }
  ).n;
  const rare = Math.max(RELAXED_RARE_MIN_DOCS, Math.ceil(total * RELAXED_RARE_FRACTION));
  return terms.filter((term) => {
    const frequency = documentFrequency(db, term);
    return frequency <= rare || frequency === total;
  });
}

/**
 * Cuántos términos informativos distintos de la consulta aparecen en el texto, contando
 * por el mismo prefijo con el que se buscó. Las palabras comunes no entran en la cuenta:
 * coincidir en "sistema" en una pregunta sobre planetas no prueba nada. Los tokens se
 * parten como FTS5 (`_` incluido), o `columna_beta` no casaría con `beta`.
 *
 * Un token más corto que PREFIX_FROM_LENGTH no casa por prefijo. Con el recorte actual,
 * "solar" baja a "sola" y una palabra de cuatro letras puede ser otra cualquiera; sin la
 * guarda, "una sola pasada" contaba como coincidencia de "solar" y rescataba una pregunta
 * ajena. Se pierde el plural que busca un singular de cuatro letras ("flores" → "flor"),
 * que el recorte tampoco encontraba en el sentido contrario.
 */
function countRelaxedMatches(text: string, terms: RelaxedTerm[]): number {
  const tokens = plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
  return terms.reduce((count, { word, prefix }) => {
    const found = tokens.some((token) =>
      prefix
        ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
        : token === word,
    );
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
  /** Lo que se devuelve: el gist. */
  text: string;
  /** Lo que indexa FTS5 y sobre lo que se cuenta: gist y detalles. */
  search_text: string;
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
  /** Lo que se devuelve al cliente. */
  text: string;
  /** Lo que indexa FTS5; si falta, se puntúa `text` (rasgos y episodios). */
  search_text?: string;
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
  queryWords: number,
): T[] {
  if (rows.length === 0 || informative.length === 0) return [];
  // Una consulta de una sola palabra no puede juntar dos coincidencias. No hace falta
  // exigirle longitud: si el rescate llegó aquí es porque el prefijo cambió la consulta, y
  // el prefijo ya exige PREFIX_FROM_LENGTH letras; una palabra corta va exacta y no se
  // rescata. En el resto, la proporción sube el mínimo con el tamaño de la consulta.
  const required =
    queryWords === 1
      ? 1
      : Math.max(RELAXED_MIN_INFORMATIVE, Math.ceil(queryWords * RELAXED_MIN_RATIO));
  // Si no hay tantos términos informativos como exige la consulta, nadie puede llegar.
  if (informative.length < required) return [];
  return rows
    .map((row) => ({
      row,
      matches: countRelaxedMatches(row.search_text ?? row.text, informative),
    }))
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
  /** Sin capa semántica que responda, el rescate es lo único que encuentra una frase natural. */
  { rescue = true }: { rescue?: boolean } = {},
): {
  traits: TraitCandidate[];
  memories: RecallHit[];
  episodes: EpisodeCandidate[];
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
    `SELECT m.id, m.scope, m.gist AS text,
            m.gist || ' ' || COALESCE(m.details, '') AS search_text,
            m.salience, m.created_at,
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
  let rescuedWordCount = 0;
  let rows = strictRows;
  if (strictEmpty && rescue) {
    const { terms, wordCount } = relaxedTerms(input.query);
    const relaxed = relaxedFts(terms);
    if (relaxed !== strict) {
      rows = run(relaxed);
      rescuedTerms = informativeTerms(db, terms);
      // La proporción cuenta lo que de verdad se busca; RELAXED_MAX_TERMS ya recortó la
      // consulta, y exigir por palabras que no llegaron a buscar sería inalcanzable.
      rescuedWordCount = Math.min(wordCount, RELAXED_MAX_TERMS);
    }
  }
  const traitRows: TraitCandidate[] = (
    rescuedTerms
      ? relaxRows(rows.traits, rescuedTerms, rescuedWordCount)
      : rows.traits
  ).map(({ fts_rank: _ftsRank, ...row }) => row);
  const episodeRows: EpisodeCandidate[] = (
    rescuedTerms
      ? relaxRows(rows.episodes, rescuedTerms, rescuedWordCount)
      : rows.episodes
  ).map(({ fts_rank: _ftsRank, ...row }) => row);

  // El rescate ya viene ordenado por coincidencias y recortado a RELAXED_MAX_RESULTS. El
  // estricto conserva el orden de FTS5 y desempata por la saliencia ya decaída: la cruda
  // favorecía lo que se usó hace mucho y no es la que ve el cliente en el hit.
  const orderedMemories = rescuedTerms
    ? relaxRows(rows.memories, rescuedTerms, rescuedWordCount)
    : rows.memories.sort(
        (a, b) =>
          Number(a.fts_rank) - Number(b.fts_rank) ||
          effectiveSalience(b, at) - effectiveSalience(a, at) ||
          a.id.localeCompare(b.id),
      );
  const memories: RecallHit[] = orderedMemories
    .slice(0, CANDIDATE_POOL_LIMIT)
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
/**
 * Índice hebbiano: cuenta el uso de cada recuerdo y el co-uso de cada par que
 * se usó en el mismo turno. Vive acá y no en `reinforceMemories` porque a esa
 * la llama también el camino de recall, donde aparecer no es haberse usado.
 */
function registrarUso(db: DB, memoryIds: readonly string[], at: number): void {
  const ids = [...new Set(memoryIds)].sort();
  if (ids.length === 0) return;

  const contar = db.prepare("UPDATE memories SET use_count = use_count + 1 WHERE id = ?");
  const emparejar = db.prepare(
    `INSERT INTO co_use (memory_a, memory_b, n, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(memory_a, memory_b) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
  );

  db.transaction(() => {
    for (const id of ids) contar.run(id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        emparejar.run(ids[i], ids[j], at);
      }
    }
  })();
}

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
  registrarUso(db, known, options.at ?? now());
  return {
    reinforced: known.length,
    traits: traits.length,
    unknown: ids.length - known.length - traits.length,
  };
}

/**
 * Recall léxico puro: es el camino sin capa semántica, así que siempre puede rescatar.
 * `recallHybrid` es quien apaga el rescate cuando hay vectores comparables que puntuar.
 */
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

/**
 * Si la búsqueda semántica de esta consulta tiene algo que puntuar: algún vector del mismo
 * modelo (si se filtró por modelo) y mismas dimensiones en el ámbito. Sin ninguno, el vector
 * de la consulta no encuentra nada y el recall queda en manos de lo léxico.
 *
 * Lleva los mismos filtros de selección que `semanticSearchMemories` (ámbito, modelo, dims y
 * ruido), no su corte por puntuación: un vector de ruido nunca se puntúa, así que no puede
 * encender la capa. El backfill no excluía el ruido hasta tarde, así que hay bases con vectores
 * de memorias `[noise]` y `[pareto:l0]`.
 */
function hasComparableVectors(
  db: DB,
  opts: { model?: string; dims: number; scope?: string },
): boolean {
  const filters = [
    opts.scope ? "m.scope = @scope" : null,
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
    excludeNoiseSql("m"),
  ].filter((value): value is string => value !== null);
  return (
    db
      .prepare(
        `SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE ${filters.join(" AND ")} LIMIT 1`,
      )
      .get({ scope: opts.scope, model: opts.model, dims: opts.dims }) !== undefined
  );
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
  const cfg = loadEmbeddingConfig();
  const actualEmbedFn =
    embedFn ?? ((texts: string[]) => embedTexts(texts, cfg, "query"));

  const vecs = await actualEmbedFn([input.query]);
  const queryVec = vecs?.[0];
  const semanticModel = options.embeddingModel ?? (embedFn ? undefined : cfg.model);
  const semantic = queryVec
    ? semanticSearchMemories(db, queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore,
        model: semanticModel,
      })
    : [];
  // El rescate léxico sólo entra cuando no hay capa semántica: embeddings apagados, el
  // embedder sin responder o ningún vector del modelo activo. Medido con 2.527 memorias, con
  // embeddings el rescate apenas suma aciertos y en cambio empuja la respuesta buena hacia
  // abajo y trae recuerdos a preguntas ajenas; sin ellos, es lo que lleva el recall de 0,1 a
  // 2,5 recuerdos por pregunta.
  const semanticLayer =
    queryVec !== undefined &&
    hasComparableVectors(db, { model: semanticModel, dims: queryVec.length, scope: input.scope });
  const lexical = lexicalCandidates(db, input, at, { rescue: !semanticLayer });
  const memories = queryVec ? fuseMemories(lexical.memories, semantic, at) : lexical.memories;
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
