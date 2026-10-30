// Owns the lexical candidate pool: the strict FTS query, its scope filters and the switch
// to the rescue, with the row types it returns.
import type { Database as DB } from "better-sqlite3";
import type { RecallInput, RecallHit } from "../schema.js";
import type { SalienceRow } from "../store/rows.js";
import { effectiveSalience } from "../memory/salience.js";
import { excludeNoiseSql } from "../store/rows.js";
import { escapeFts } from "./fts.js";
import {
  informativeTerms,
  RELAXED_MAX_TERMS,
  relaxRows,
  relaxedFts,
  relaxedTerms,
  type RelaxedTerm,
} from "./rescue.js";

export const CANDIDATE_POOL_LIMIT = 50;
const MEMORY_FTS_SCAN_LIMIT = 200;

export interface TraitCandidate {
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
  fts_rank: number;
}

export interface EpisodeCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

/** Lo mínimo para ordenar candidatos rescatados: texto, id y puesto de FTS5. */
export interface RankedCandidate {
  id: string;
  /** Lo que se devuelve al cliente. */
  text: string;
  /** Lo que indexa FTS5; si falta, se puntúa `text` (rasgos y episodios). */
  search_text?: string;
  fts_rank: number;
}

type RankedTrait = TraitCandidate & { fts_rank: number };
type RankedEpisode = EpisodeCandidate & { fts_rank: number };

export function lexicalCandidates(
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
    traits: RankedTrait[];
    memories: MemoryCandidate[];
    episodes: RankedEpisode[];
  } => ({
    traits: traitStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as RankedTrait[],
    memories: memoryStmt.all({
      q,
      scope: input.scope,
      limit: MEMORY_FTS_SCAN_LIMIT,
    }) as MemoryCandidate[],
    episodes: episodeStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as RankedEpisode[],
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
