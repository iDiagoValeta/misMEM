/**
 * misMEM viewer — read-only control panel.
 *
 * Endpoints (todos detrás de la misma BasicAuth de /mcp):
 *   GET /viewer            → la interfaz compilada (ui/ → dist/ui), ver viewer-static.ts
 *   GET /api/stats         → totales por capa + top scopes
 *   GET /api/recent        → últimas N filas de una capa (?layer=&scope=&limit=)
 *   GET /api/search        → recall híbrido read-only (?q=&scope=&limit=)
 *
 * Cero dependencias nuevas, cero escrituras desde el browser.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { recallHybrid } from "./tools.js";
import type { EmbedFn } from "./embeddings/index.js";

type Layer = "episode" | "memory" | "trait";
const LAYERS: readonly Layer[] = ["episode", "memory", "trait"] as const;

function isLayer(v: string | null): v is Layer {
  return v !== null && (LAYERS as readonly string[]).includes(v);
}

export function clampLimit(raw: string | null, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

export function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export function handleStats(db: DB, res: ServerResponse): void {
  const counts = {
    episodes: (
      db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }
    ).n,
    memories: (
      db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
    ).n,
    traits: (
      db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number }
    ).n,
    consolidated: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NOT NULL",
        )
        .get() as { n: number }
    ).n,
  };
  const topScopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM episodes
       GROUP BY scope ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ scope: string; n: number }>;
  const last = db
    .prepare(
      "SELECT id, scope, created_at FROM episodes ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { id: string; scope: string; created_at: number } | undefined;
  json(res, 200, { counts, topScopes, last: last ?? null });
}

export function handleRecent(db: DB, res: ServerResponse, url: URL): void {
  const layerParam = url.searchParams.get("layer") ?? "episode";
  if (!isLayer(layerParam)) {
    json(res, 400, { error: `invalid layer: ${layerParam}` });
    return;
  }
  const layer: Layer = layerParam;
  const scope = url.searchParams.get("scope");
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  let rows: unknown[];
  if (layer === "episode") {
    rows = db
      .prepare(
        `SELECT id, scope, body AS text, created_at, consolidated_into
         FROM episodes
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else if (layer === "memory") {
    rows = db
      .prepare(
        `SELECT id, scope, gist AS text, details, salience, created_at, last_accessed_at
         FROM memories
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY salience DESC, created_at DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else {
    rows = db
      .prepare(
        `SELECT id, scope, name AS text, strength, polarity, created_at, updated_at
         FROM traits
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY strength DESC, updated_at DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  }
  json(res, 200, { layer, scope, rows });
}

export async function handleSearch(
  db: DB,
  res: ServerResponse,
  url: URL,
  embedFn?: EmbedFn,
  embeddingModel?: string,
): Promise<void> {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) {
    json(res, 400, { error: "missing q" });
    return;
  }
  const scope = url.searchParams.get("scope") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"), 20, 50);
  try {
    const out = await recallHybrid(
      db,
      { query, scope, limit },
      embedFn,
      { reinforce: false, embeddingModel },
    );
    json(res, 200, out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
}
