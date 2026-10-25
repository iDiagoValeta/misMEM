#!/usr/bin/env node
/**
 * HTTP MCP server (Streamable HTTP transport).
 *
 * Diseñado para deploy detrás de Traefik con BasicAuth.
 * Reemplazo drop-in de Engram (mismo path /mcp, mismas tools mem_*).
 *
 * Env vars:
 *   MISMEM_HTTP_PORT     (default 3200)
 *   MISMEM_HTTP_HOST     (default 0.0.0.0)
 *   MISMEM_AUTH_USER     opcional: con MISMEM_AUTH_PASS, BasicAuth en /mcp, /viewer y /api
 *   MISMEM_AUTH_PASS     pareja del anterior; con una sola de las dos no arranca
 *   MISMEM_DB            ruta SQLite (default ~/.mismem/mem.db)
 *   MISMEM_ALLOWED_HOSTS sin auth, nombres de Host aceptados además de loopback (coma)
 *   MISMEM_HTTP_MAX_BODY_BYTES  tope del cuerpo de POST /mcp (default 4 MiB); más, 413
 *
 * Endpoints:
 *   GET  /healthz   →  200 ok (liveness)
 *   POST /mcp       →  MCP JSON-RPC (Streamable HTTP)
 *   GET  /mcp       →  SSE stream (Streamable HTTP)
 *   DELETE /mcp     →  cierra stream
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDefaultDb } from "./db.js";
import { hostAllowed, parseHostList } from "./http-host.js";
import { BodyTooLargeError, InvalidJsonError, isJsonContentType, loadMaxBodyBytes, readJsonBody } from "./http-body.js";
import { loadAuth } from "./http-guard.js";
import { createServer } from "./server-core.js";
import {
  handleViewerHtml,
  handleStats,
  handleRecent,
  handleSearch,
} from "./viewer.js";

const PORT = Number(process.env.MISMEM_HTTP_PORT ?? 3200);
const HOST = process.env.MISMEM_HTTP_HOST ?? "0.0.0.0";
const ALLOWED_HOSTS = parseHostList(process.env.MISMEM_ALLOWED_HOSTS);
const MAX_BODY_BYTES = loadMaxBodyBytes();

let AUTH: ReturnType<typeof loadAuth>;
try {
  AUTH = loadAuth();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[mismem-http] ${(err as Error).message}`);
  process.exit(1);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkBasicAuth(req: IncomingMessage): boolean {
  if (!AUTH) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, AUTH.user) && safeEqual(pass, AUTH.pass);
}

function send401(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="misMEM"');
  res.end("Unauthorized");
}

const db = openDefaultDb();

const httpServer = createHttpServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host, { auth: AUTH !== null, extra: ALLOWED_HOSTS })) {
      res.statusCode = 403;
      res.end("Forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "mismem" }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (!checkBasicAuth(req)) {
        send401(res);
        return;
      }
      let parsedBody: unknown;
      if (req.method === "POST") {
        // Antes de leer un byte: el SDK tira 415 igual, pero sólo después de parsear.
        if (!isJsonContentType(req.headers["content-type"])) {
          res.statusCode = 415;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Unsupported Media Type: Content-Type must be application/json",
              },
              id: null,
            }),
          );
          return;
        }
        try {
          parsedBody = await readJsonBody(req, MAX_BODY_BYTES);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            res.statusCode = 413;
            // Lo que quede sin leer no se drena: se cierra la conexión.
            res.setHeader("connection", "close");
            res.end("Payload Too Large");
            return;
          }
          if (err instanceof InvalidJsonError) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: "Parse error" },
                id: null,
              }),
            );
            return;
          }
          throw err;
        }
      }
      // Stateless: cada request es independiente — server + transport per-request.
      // Coincide con el ejemplo oficial simpleStatelessStreamableHttp.ts del SDK.
      const mcpServer = createServer(db);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Read-only viewer + JSON API. Misma BasicAuth que /mcp.
    if (
      url.pathname === "/viewer" ||
      url.pathname === "/" ||
      url.pathname.startsWith("/api/")
    ) {
      if (!checkBasicAuth(req)) {
        send401(res);
        return;
      }
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        res.end("Method Not Allowed");
        return;
      }
      if (url.pathname === "/api/stats") return handleStats(db, res);
      if (url.pathname === "/api/recent") return handleRecent(db, res, url);
      if (url.pathname === "/api/search") {
        await handleSearch(db, res, url);
        return;
      }
      return handleViewerHtml(res);
    }

    res.statusCode = 404;
    res.end("Not Found");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[mcp]", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: message }));
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `misMEM HTTP listening on http://${HOST}:${PORT} (mcp=/mcp viewer=/viewer)`,
  );
});

const shutdown = (): void => {
  httpServer.close();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
