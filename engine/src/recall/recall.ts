// Owns both recall paths, the switch that decides whether recall reinforces what it
// returns, and the hit shape they share.
import type { Database as DB } from "better-sqlite3";
import { RecallInput, type RecallHit } from "../schema.js";
import { CANDIDATE_POOL_LIMIT, lexicalCandidates } from "./lexical.js";
import { fuseMemories, hasComparableVectors } from "./fuse.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "../embeddings/provider.js";
import { semanticSearchMemories } from "../embeddings/store.js";
import { reinforceMemories } from "../memory/salience.js";

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

/**
 * Both recall paths rank traits first, then memories, then episodes, and cut to the limit;
 * the hit shape is built here so the two paths cannot drift apart.
 */
function finalizeHits(
  db: DB,
  layers: {
    traits: readonly Omit<RecallHit, "layer">[];
    memories: readonly RecallHit[];
    episodes: readonly Omit<RecallHit, "layer">[];
  },
  limit: number,
  options: RecallOptions,
  at: number,
): { hits: RecallHit[] } {
  const hits: RecallHit[] = [
    ...layers.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...layers.memories,
    ...layers.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, limit);

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
 * Recall léxico puro: es el camino sin capa semántica, así que siempre puede rescatar.
 * `recallHybrid` es quien apaga el rescate cuando hay vectores comparables que puntuar.
 */
export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? Date.now();
  const lexical = lexicalCandidates(db, input, at);
  return finalizeHits(
    db,
    { traits: lexical.traits, memories: lexical.memories, episodes: lexical.episodes },
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
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
  const at = options.at ?? Date.now();
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
  return finalizeHits(
    db,
    { traits: lexical.traits, memories, episodes: lexical.episodes },
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
}
