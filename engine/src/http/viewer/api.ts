/**
 * API de sólo lectura para la interfaz: de dónde sale cada recuerdo.
 *
 * Endpoints (misma auth y mismo filtro de Host que el resto de /api):
 *   GET /api/scopes          → ámbitos con sus conteos por capa
 *   GET /api/memories        → memorias por salience efectiva (?scope=&limit=&offset=&noise=1)
 *   GET /api/memory/:id      → la memoria, sus episodios de origen y los rasgos que la citan
 *   GET /api/trait/:id       → el rasgo y las memorias que lo sostienen
 *   GET /api/graph           → nodos y aristas episodio → memoria → rasgo (?scope=&episodes=1),
 *                              memoria ↔ memoria por parecido (?related=1) y memoria ↔ memoria
 *                              por co-uso medido (?co_use=1, soporte con ?co_use_min_n=k), que
 *                              añade el grado de cada nodo y un resumen del tamaño de la
 *                              muestra; sin el parámetro no aparece nada de eso
 *
 * La salience que devuelve es la efectiva (con el decaimiento aplicado a hoy), la misma que
 * usa el recall. La guardada sólo es el valor del último checkpoint.
 *
 * Las consultas viven en engine/src/queries/; acá sólo se valida la entrada, se llama y se
 * responde.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { graphData, type GraphCaps } from "../../queries/graph.js";
import { listMemories, memoryDetail } from "../../queries/memories.js";
import { scopeCounts } from "../../queries/scopes.js";
import { traitDetail } from "../../queries/traits.js";
import { json } from "../respond.js";
import { clampLimit, parseOffset } from "./read.js";

export type { GraphCaps } from "../../queries/graph.js";

export type DetailPath = { layer: "memory" | "trait"; id: string };

/**
 * Una ruta de detalle con el id mal codificado (% suelto o una secuencia UTF-8 a medias)
 * es culpa de quien llama, no del servidor: devuelve "bad" para responder 400 en vez de
 * dejar que decodeURIComponent lance URIError y el catch general lo disfrace de 500.
 */
export function parseDetailPath(pathname: string): DetailPath | "bad" | null {
  const match = /^\/api\/(memory|trait)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2] ?? "");
    return id ? { layer: match[1] as DetailPath["layer"], id } : "bad";
  } catch {
    return "bad";
  }
}

export function handleScopes(db: DB, res: ServerResponse): void {
  json(res, 200, { scopes: scopeCounts(db) });
}

export function handleMemories(db: DB, res: ServerResponse, url: URL, at = Date.now()): void {
  const scope = url.searchParams.get("scope");
  const withNoise = url.searchParams.get("noise") === "1";
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);
  const offset = parseOffset(url.searchParams.get("offset"));

  json(res, 200, listMemories(db, { scope, withNoise, limit, offset, at }));
}

export function handleMemory(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const detail = memoryDetail(db, id, at);
  if (!detail) {
    json(res, 404, { error: `no existe la memoria: ${id}` });
    return;
  }
  json(res, 200, detail);
}

export function handleTrait(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const detail = traitDetail(db, id, at);
  if (!detail) {
    json(res, 404, { error: `no existe el rasgo: ${id}` });
    return;
  }
  json(res, 200, detail);
}

export function handleGraph(
  db: DB,
  res: ServerResponse,
  url: URL,
  at = Date.now(),
  caps: GraphCaps = {},
): void {
  const scope = url.searchParams.get("scope");
  const withEpisodes = url.searchParams.get("episodes") === "1";
  const withRelated = url.searchParams.get("related") === "1";
  // The co-use layer is opt-in: without the parameter the response does not change at
  // all, because this is the contract the interface already consumes.
  const withCoUse = url.searchParams.get("co_use") === "1";
  const coUseMinN = Math.max(1, Number(url.searchParams.get("co_use_min_n") ?? 1) || 1);

  json(res, 200, graphData(db, { scope, withEpisodes, withRelated, withCoUse, coUseMinN, at, caps }));
}
