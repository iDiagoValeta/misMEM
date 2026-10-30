/**
 * Despacho de las peticiones HTTP del servidor: Host, /healthz, /mcp, el visor y su API.
 *
 * Vive aparte de server-http.ts, que escucha al importarse, para poder probarlo sin abrir
 * un puerto. Todo lo que era global del módulo (base, auth, topes, el job de consolidación,
 * el transporte del MCP y la interfaz compilada) entra por parámetro; http/ no puede
 * importar la raíz salvo env.ts, cli-args.ts y schema.ts.
 *
 * El orden de las comprobaciones es parte del contrato: Host → healthz → /mcp con auth →
 * visor y API con auth → POST → método → rutas → 404.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import type { ConsolidationJob } from "../consolidation/job.js";
import { BodyTooLargeError, InvalidJsonError, isJsonContentType, readJsonBody } from "./body.js";
import { checkBasicAuth, type BasicCredentials } from "./guard.js";
import { hostAllowed } from "./host.js";
import { json, jsonBare, jsonPlain, methodNotAllowed, notFound, payloadTooLarge, unauthorized } from "./respond.js";
import { handleGraph, handleMemories, handleMemory, handleScopes, handleTrait, parseDetailPath } from "./viewer/api.js";
import {
  ACTION_MAX_BODY_BYTES,
  type ForgetConfirmations,
  handleAction,
  writeGuard,
} from "./viewer/actions.js";
import { handleRecent, handleSearch, handleStats } from "./viewer/read.js";

export interface HttpRoutesDeps {
  db: DB;
  auth: BasicCredentials | null;
  /** `MISMEM_ALLOWED_HOSTS`: nombres de Host aceptados además de loopback sin auth. */
  allowedHosts: readonly string[];
  /** Tope del cuerpo de POST /mcp (`MISMEM_HTTP_MAX_BODY_BYTES`). */
  maxBodyBytes: number;
  /** La corrida de consolidación que lanza la interfaz: una a la vez por proceso. */
  job: ConsolidationJob;
  allowDelete: boolean;
  confirmations: ForgetConfirmations;
  /** Atiende /mcp ya autorizado y con el cuerpo leído; el transporte vive en la raíz. */
  handleMcp: (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void>;
  /** La interfaz compilada; vive en la raíz porque lee dist/ui. */
  serveUi: (res: ServerResponse, pathname: string) => void;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRequestHandler(deps: HttpRoutesDeps): RequestHandler {
  const { db, auth, allowedHosts, maxBodyBytes, job, allowDelete, confirmations, handleMcp, serveUi } = deps;

  return async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, { auth: auth !== null, extra: allowedHosts })) {
        res.statusCode = 403;
        res.end("Host no permitido");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz") {
        jsonBare(res, 200, { status: "ok", service: "mismem" });
        return;
      }

      if (url.pathname === "/mcp") {
        if (!checkBasicAuth(req.headers.authorization, auth)) {
          unauthorized(res);
          return;
        }
        let parsedBody: unknown;
        if (req.method === "POST") {
          // Antes de leer un byte: el SDK tira 415 igual, pero sólo después de parsear.
          if (!isJsonContentType(req.headers["content-type"])) {
            jsonBare(res, 415, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Tipo de contenido no soportado: Content-Type debe ser application/json",
              },
              id: null,
            });
            return;
          }
          try {
            parsedBody = await readJsonBody(req, maxBodyBytes);
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              payloadTooLarge(res);
              return;
            }
            if (err instanceof InvalidJsonError) {
              jsonBare(res, 400, {
                jsonrpc: "2.0",
                error: { code: -32700, message: "Error de parseo" },
                id: null,
              });
              return;
            }
            throw err;
          }
        }
        await handleMcp(req, res, parsedBody);
        return;
      }

      // Viewer + su API. Misma BasicAuth que /mcp; las escrituras, además, con writeGuard.
      if (
        url.pathname === "/viewer" ||
        url.pathname.startsWith("/viewer/") ||
        url.pathname === "/" ||
        url.pathname.startsWith("/api/")
      ) {
        if (!checkBasicAuth(req.headers.authorization, auth)) {
          unauthorized(res);
          return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/")) {
          const rejected = writeGuard(req);
          if (rejected) {
            res.statusCode = rejected.status;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: rejected.error }));
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req, ACTION_MAX_BODY_BYTES);
          } catch (err) {
            const tooLarge = err instanceof BodyTooLargeError;
            if (!tooLarge && !(err instanceof InvalidJsonError)) throw err;
            res.statusCode = tooLarge ? 413 : 400;
            if (tooLarge) res.setHeader("connection", "close");
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: tooLarge ? "cuerpo demasiado grande" : "JSON inválido" }));
            return;
          }
          const actionOpts = { job, allowDelete, confirmations };
          if (await handleAction(db, res, url.pathname, body, actionOpts)) return;
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: `acción desconocida: ${url.pathname}` }));
          return;
        }
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }
        if (url.pathname === "/api/stats") return handleStats(db, res);
        if (url.pathname === "/api/recent") return handleRecent(db, res, url);
        if (url.pathname === "/api/search") {
          await handleSearch(db, res, url);
          return;
        }
        if (url.pathname === "/api/scopes") return handleScopes(db, res);
        if (url.pathname === "/api/consolidate") {
          json(res, 200, job.state());
          return;
        }
        if (url.pathname === "/api/memories") return handleMemories(db, res, url);
        if (url.pathname === "/api/graph") return handleGraph(db, res, url);
        const detail = parseDetailPath(url.pathname);
        if (detail === "bad") return json(res, 400, { error: "id mal codificado" });
        if (detail) {
          return detail.layer === "memory" ? handleMemory(db, res, detail.id) : handleTrait(db, res, detail.id);
        }
        if (url.pathname.startsWith("/api/")) {
          jsonPlain(res, 404, { error: `endpoint desconocido: ${url.pathname}` });
          return;
        }
        return serveUi(res, url.pathname);
      }

      notFound(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[mcp]", err);
      if (!res.headersSent) {
        jsonBare(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  };
}
