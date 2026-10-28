// Owns the read queries shared by the viewer API and the Obsidian export: related-memory links from stored vectors and id-array parsing.
import type { Database as DB } from "better-sqlite3";
import { cosine } from "./embeddings/vector.js";

// Con nomic-embed-text hasta lo que no tiene nada que ver da 0,6-0,7 de coseno: medido en
// una base real (118 memorias), la vecina más cercana tiene mediana 0,795. Con 0,75 y tres
// vecinas por memoria salen grupos; más bajo, todo se conecta con todo.
const RELATED_MIN_SCORE = 0.75;
const RELATED_PER_NODE = 3;

export type GraphLink = { source: string; target: string; kind: "origin" | "evidence" | "related"; score?: number };

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

/** Los arrays de ids viven como JSON en una columna de texto: uno roto no rompe la respuesta. */
export function parseIds(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
