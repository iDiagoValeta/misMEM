/**
 * misMEM viewer — API de lectura y UI compilada.
 *
 * Endpoints (todos detrás de la misma BasicAuth de /mcp):
 *   GET /viewer            → la interfaz compilada (ui/ → dist/ui), ver viewer-static.ts
 *   GET /api/stats         → totales por capa + top scopes
 *   GET /api/recent        → últimas N filas de una capa (?layer=&scope=&limit=)
 *   GET /api/search        → recall híbrido read-only (?q=&scope=&limit=)
 *   El resto de GET /api/* (scopes, memories, memory/:id, trait/:id, graph) vive en viewer-api.ts.
 *
 * Nada de acá escribe: las acciones (editar, desconsolidar, los dos forget en dos
 * pasos, cristalizar, lanzar una consolidación) viven en viewer-actions.ts.
 *
 * Las consultas viven en engine/src/queries/: acá sólo se valida la entrada, se llama y se
 * responde. Cero dependencias nuevas.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { countPendingEpisodes, pendingEpisodes } from "../../memory/pending.js";
import { recentRows } from "../../queries/recent.js";
import { viewerStats } from "../../queries/stats.js";
import { recallHybrid } from "../../recall/recall.js";
import type { EmbedFn } from "../../embeddings/provider.js";
import { Layer } from "../../schema.js";
import { json } from "../respond.js";

// One source for the layer names: the Zod enum that validates them.
const LAYERS: readonly Layer[] = Layer.options;

function isLayer(v: string | null): v is Layer {
  return v !== null && (LAYERS as readonly string[]).includes(v);
}

export function clampLimit(raw: string | null, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

/**
 * Un offset inválido o negativo cuenta como 0; SQLite no acepta NaN ni Infinity. Pasado
 * MAX_SAFE_INTEGER (1e20) deja de ser un entero que SQLite pueda bindear: se recorta.
 */
export function parseOffset(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
}

export function handleStats(db: DB, res: ServerResponse): void {
  json(res, 200, viewerStats(db));
}

export function handleRecent(db: DB, res: ServerResponse, url: URL): void {
  const layerParam = url.searchParams.get("layer") ?? "episode";
  if (!isLayer(layerParam)) {
    json(res, 400, { error: `capa inválida: ${layerParam}` });
    return;
  }
  const layer: Layer = layerParam;
  const scope = url.searchParams.get("scope");
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  // Sólo los episodios tienen estado de consolidación: en las otras capas `pending` no
  // cambia nada y la respuesta sigue siendo la de siempre, sin `total`.
  if (layer === "episode" && url.searchParams.get("pending") === "1") {
    const offset = parseOffset(url.searchParams.get("offset"));
    // El total es el de todos los pendientes: el cliente pagina con él, no con el tamaño de la página.
    const total = countPendingEpisodes(db, scope);
    const rows = pendingEpisodes(db, scope, limit, offset);
    json(res, 200, { layer, scope, rows, total });
    return;
  }

  json(res, 200, { layer, scope, rows: recentRows(db, layer, scope, limit) });
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
    json(res, 400, { error: "falta q" });
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
