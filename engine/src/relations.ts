// Owns the read queries shared by the viewer API and the Obsidian export: lateral memory-to-memory
// links — by similarity from stored vectors, and by measured co-use — and id-array parsing.
import type { Database as DB } from "better-sqlite3";
import { cosine } from "./embeddings/vector.js";
import { coUseEdges } from "./connectome.js";

// Con nomic-embed-text hasta lo que no tiene nada que ver da 0,6-0,7 de coseno: medido en
// una base real (118 memorias), la vecina más cercana tiene mediana 0,795. Con 0,75 y tres
// vecinas por memoria salen grupos; más bajo, todo se conecta con todo.
const RELATED_MIN_SCORE = 0.75;
const RELATED_PER_NODE = 3;

export type GraphLink = {
  source: string;
  target: string;
  kind: "origin" | "evidence" | "related" | "co_use";
  /** Cosine, `related` only. */
  score?: number;
  /** Turns backing the edge, `co_use` only: strength does not read without its support. */
  n?: number;
  /** NPMI, `co_use` only. */
  strength?: number;
};

/**
 * Aristas entre memorias parecidas, con los vectores ya guardados (no llama al embedder).
 * Cada memoria aporta sus vecinas más cercanas por encima del umbral; la arista no tiene
 * sentido, así que a-b y b-a cuentan una vez. Sólo compara vectores del modelo más usado:
 * los de modelos distintos no son comparables.
 */
export function relatedLinks(
  db: DB,
  memoryIds: readonly string[],
  opts: { minScore?: number; perNode?: number } = {},
): GraphLink[] {
  const minScore = opts.minScore ?? RELATED_MIN_SCORE;
  const perNode = opts.perNode ?? RELATED_PER_NODE;
  const rows = db
    .prepare(
      `SELECT memory_id, model, vec FROM memory_embeddings
       WHERE memory_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(memoryIds)) as Array<{ memory_id: string; model: string; vec: Buffer }>;
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  const model = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const vectors = rows
    .filter((r) => r.model === model)
    .map((r) => ({ id: r.memory_id, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4) }));

  const links = new Map<string, GraphLink>();
  for (const a of vectors) {
    const nearest = vectors
      .filter((b) => b !== a)
      .map((b) => ({ id: b.id, score: cosine(a.vec, b.vec) }))
      .filter((n) => n.score >= minScore)
      .sort((x, y) => y.score - x.score)
      .slice(0, perNode);
    for (const n of nearest) {
      const [source, target] = a.id < n.id ? [a.id, n.id] : [n.id, a.id];
      links.set(`${source}|${target}`, { source, target, kind: "related", score: n.score });
    }
  }
  return [...links.values()];
}

/**
 * Edges from measured co-use: which memories one turn used together. Where `relatedLinks`
 * compares what each memory says, this comes from what actually happened. The weight is
 * NPMI rather than the count, because a memory used in every turn co-occurs with
 * everything while orienting nobody — see `connectome.ts`.
 */
export function coUseLinks(db: DB, memoryIds: readonly string[], minN = 1): GraphLink[] {
  return coUseEdges(db, { ids: memoryIds, minN }).map((e) => ({
    source: e.memory_a,
    target: e.memory_b,
    kind: "co_use" as const,
    n: e.n,
    strength: e.strength,
  }));
}

/** Los arrays de ids viven como JSON en una columna de texto: uno roto no rompe la respuesta. */
export function parseIds(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
