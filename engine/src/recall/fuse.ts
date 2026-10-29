// Owns the fusion of the lexical and semantic lists with RRF, where salience only breaks
// ties, and the check that decides whether the semantic layer has anything to score.
import type { Database as DB } from "better-sqlite3";
import type { RecallHit } from "../schema.js";
import type { SemanticHit } from "../embeddings/store.js";
import { effectiveSalience } from "../memory/salience.js";
import { excludeNoiseSql } from "../store/rows.js";

const RRF_K = 60;
// Menor que un puesto de RRF en la cima (1/61 - 1/62 ≈ 0.00026): ahí la saliencia
// sólo desempata. Más abajo los puestos se achican (≈ 0.00008 al final de los 50
// candidatos) y una saliencia alta puede adelantar dos o tres lugares.
const SALIENCE_RRF_WEIGHT = 0.0002;

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
export function hasComparableVectors(
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

export function fuseMemories(
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
