#!/usr/bin/env node
/**
 * HTTP MCP server (Streamable HTTP transport).
 *
 * Diseñado para deploy detrás de Traefik con BasicAuth.
 * Reemplazo drop-in de Engram (mismo path /mcp, mismas tools mem_*).
 *
 * Env vars:
 *   MISMEM_HTTP_PORT     (default 3200)
 *   MISMEM_HTTP_HOST     (default 127.0.0.1; containers set 0.0.0.0)
 *   MISMEM_AUTH_USER     opcional: con MISMEM_AUTH_PASS, BasicAuth en /mcp, /viewer y /api
 *   MISMEM_AUTH_PASS     pareja del anterior; con una sola de las dos no arranca
 *   MISMEM_DB            ruta SQLite (default ~/.mismem/mem.db)
 *   MISMEM_ALLOWED_HOSTS sin auth, nombres de Host aceptados además de loopback (coma)
 *   MISMEM_HTTP_MAX_BODY_BYTES  tope del cuerpo de POST /mcp (default 4 MiB); más, 413
 *   MISMEM_VIEWER_ALLOW_DELETE  1 para que la interfaz pueda olvidar memorias y rasgos (default apagado)
 *
 * Endpoints:
 *   GET  /healthz   →  200 ok (liveness)
 *   POST /mcp       →  MCP JSON-RPC (Streamable HTTP)
 *   GET  /mcp       →  SSE stream (Streamable HTTP)
 *   DELETE /mcp     →  cierra stream
 *
 * El despacho vive en http/routes.ts: acá sólo se lee el entorno, se abre la base, se
 * compone el handler y se escucha.
 */
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDefaultDb } from "./store/db.js";
import { parseHostList } from "./http/host.js";
import { loadMaxBodyBytes } from "./http/body.js";
import { bindHost, httpPort, loadAuth } from "./http/guard.js";
import { createRequestHandler } from "./http/routes.js";
import { createServer } from "./server-core.js";
import { serveUi } from "./viewer-static.js";
import { ForgetConfirmations, loadAllowDelete } from "./http/viewer/actions.js";
import { ConsolidationJob } from "./consolidation/job.js";

const PORT = httpPort();
const HOST = bindHost();
const ALLOWED_HOSTS = parseHostList(process.env.MISMEM_ALLOWED_HOSTS);
const MAX_BODY_BYTES = loadMaxBodyBytes();

let AUTH: ReturnType<typeof loadAuth>;
try {
  AUTH = loadAuth();
} catch (err) {
  console.error(`[mismem-http] ${(err as Error).message}`);
  process.exit(1);
}

const db = openDefaultDb();
// La corrida de consolidación que se lanza desde la interfaz: una a la vez por proceso.
const consolidationJob = new ConsolidationJob(db);
const ALLOW_DELETE = loadAllowDelete();
const forgetConfirmations = new ForgetConfirmations();

const handler = createRequestHandler({
  db,
  auth: AUTH,
  allowedHosts: ALLOWED_HOSTS,
  maxBodyBytes: MAX_BODY_BYTES,
  job: consolidationJob,
  allowDelete: ALLOW_DELETE,
  confirmations: forgetConfirmations,
  // Stateless: cada request es independiente, con server y transport por petición.
  // Coincide con el ejemplo oficial simpleStatelessStreamableHttp.ts del SDK.
  handleMcp: async (req, res, parsedBody) => {
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
  },
  serveUi,
});

const httpServer = createHttpServer(handler);

httpServer.listen(PORT, HOST, () => {
  console.log(
    `misMEM HTTP escuchando en http://${HOST}:${PORT} (mcp=/mcp viewer=/viewer)`,
  );
});

const shutdown = (): void => {
  httpServer.close();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
