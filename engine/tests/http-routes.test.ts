import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { ConsolidationJob } from "../src/consolidation/job.js";
import { ACTION_MAX_BODY_BYTES, ForgetConfirmations } from "../src/http/viewer/actions.js";
import { createRequestHandler, type HttpRoutesDeps, type RequestHandler } from "../src/http/routes.js";
import { openDb } from "../src/store/db.js";

// El despacho se prueba aquí sin abrir un puerto: server-http.test.ts sigue cubriendo el
// proceso real (bind, auth y Host), y este fichero fija el orden de las comprobaciones.

const AUTH = { user: "brain", pass: "s3cret" };
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  /** Cuántas veces se llamó a `end`: el catch del despacho cierra una respuesta ya enviada. */
  endCount: number;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    endCount: 0,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      // ServerResponse marca headersSent al terminar y un segundo end no reescribe el cuerpo.
      this.endCount++;
      this.headersSent = true;
      this.body = payload ?? this.body;
    },
  };
}

async function request(
  handler: RequestHandler,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: readonly string[] } = {},
): Promise<MockResponse> {
  const res = mockRes();
  // readJsonBody escucha "data"/"end": un Readable es el doble mínimo de un IncomingMessage
  // con cuerpo. Sin `body` no se emite nada, como en un GET.
  const req = Object.assign(Readable.from((opts.body ?? []).map((chunk) => Buffer.from(chunk))), {
    method: opts.method ?? "GET",
    url: path,
    headers: { host: "localhost", ...opts.headers },
  });
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeHandler(overrides: Partial<HttpRoutesDeps> = {}): RequestHandler {
  return createRequestHandler({
    db,
    auth: AUTH,
    allowedHosts: [],
    maxBodyBytes: 1024,
    job: new ConsolidationJob(db),
    allowDelete: false,
    confirmations: new ForgetConfirmations(),
    handleMcp: async () => {
      throw new Error("el test no debe llegar a /mcp");
    },
    serveUi: (res) => {
      res.statusCode = 200;
      res.end("ui");
    },
    ...overrides,
  });
}

describe("http/routes: orden y respuestas", () => {
  it("rechaza un Host no permitido antes que nada, también en /healthz", async () => {
    // Sin auth, el Host es la única guarda: debe ganar a /healthz y a la API.
    const handler = makeHandler({ auth: null });
    for (const path of ["/healthz", "/api/stats"]) {
      const res = await request(handler, path, { headers: { host: "evil.example.com" } });
      expect(res.statusCode, path).toBe(403);
      expect(res.body).toBe("Host no permitido");
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
  });

  it("sirve /healthz sin auth", async () => {
    const res = await request(makeHandler({ auth: null }), "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ status: "ok", service: "mismem" });
  });

  it("devuelve 401 con el reto en /api cuando hay auth y faltan credenciales", async () => {
    const res = await request(makeHandler(), "/api/stats");
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="misMEM"');
    expect(res.body).toBe("No autorizado");
  });

  it("devuelve 405 para un método que no es GET ni POST en /api", async () => {
    const res = await request(makeHandler(), "/api/stats", {
      method: "PUT",
      headers: { authorization: basic(AUTH.user, AUTH.pass) },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET, POST");
    expect(res.body).toBe("Método no permitido");
  });

  it("devuelve 404 JSON para un endpoint /api desconocido", async () => {
    const res = await request(makeHandler(), "/api/nope", {
      headers: { authorization: basic(AUTH.user, AUTH.pass) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ error: "endpoint desconocido: /api/nope" });
  });

  it("devuelve 404 de texto fuera del visor", async () => {
    const res = await request(makeHandler({ auth: null }), "/nope");
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("No encontrado");
    expect(res.headers["content-type"]).toBeUndefined();
  });
});

// Los dos 413 no se pueden separar en otro fichero: comparten el `request` que arma el handler.
describe("http/routes: cuerpo demasiado grande (413)", () => {
  it("cierra la conexión en /mcp y manda el texto de respond.payloadTooLarge", async () => {
    // El tope se baja para no depender del valor por defecto de makeHandler.
    const res = await request(makeHandler({ maxBodyBytes: 16 }), "/mcp", {
      method: "POST",
      headers: {
        authorization: basic(AUTH.user, AUTH.pass),
        "content-type": "application/json",
      },
      // Sin Content-Length, el corte ocurre al leer los chunks.
      body: ["x".repeat(17)],
    });
    expect(res.statusCode).toBe(413);
    // Sin esto el cliente seguiría escribiendo en un socket que nadie drena.
    expect(res.headers.connection).toBe("close");
    expect(res.headers["content-type"]).toBeUndefined();
    expect(res.body).toBe("Cuerpo demasiado grande");
  });

  it("en una acción de /api responde JSON y también cierra la conexión", async () => {
    const res = await request(makeHandler(), "/api/crystallize", {
      method: "POST",
      headers: {
        authorization: basic(AUTH.user, AUTH.pass),
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: ["x".repeat(ACTION_MAX_BODY_BYTES + 1)],
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers.connection).toBe("close");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.body).toBe('{"error":"cuerpo demasiado grande"}');
  });
});

describe("http/routes: error no controlado (500)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("responde el JSON sin charset y deja el error en stderr", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      makeHandler({
        handleMcp: async () => {
          throw new Error("boom");
        },
      }),
      "/mcp",
      { headers: { authorization: basic(AUTH.user, AUTH.pass) } },
    );
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.body).toBe('{"error":"boom"}');
    // El motivo va al cliente y al log: lo único que lo deja rastro es esa etiqueta.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe("[mcp]");
  });

  it("con las cabeceras ya enviadas sólo cierra la respuesta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      makeHandler({
        handleMcp: async (_req, response) => {
          response.end("parcial");
          throw new Error("tarde");
        },
      }),
      "/mcp",
      { headers: { authorization: basic(AUTH.user, AUTH.pass) } },
    );
    // Un JSON de error aquí corrompería el cuerpo que ya salió.
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({});
    expect(res.body).toBe("parcial");
    expect(res.endCount).toBe(2);
  });
});
