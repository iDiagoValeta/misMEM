import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { BodyTooLargeError, InvalidJsonError, readJsonBody } from "../src/http-body.js";

function request(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe("http-body: readJsonBody", () => {
  it("devuelve el JSON cuando entra en el tope", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(readJsonBody(request([body]), 1024)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
  });

  it("corta por Content-Length sin leer el cuerpo", async () => {
    let read = false;
    const req = request(['{"a":1}'], { "content-length": "5000" });
    req.on("data", () => (read = true));
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(read).toBe(false);
  });

  it("corta en chunked en cuanto pasa el tope, sin juntar el resto", async () => {
    let produced = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        produced++;
        yield Buffer.alloc(100, "a");
      }
    }
    const req = Readable.from(endless()) as unknown as IncomingMessage;
    req.headers = {};
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(produced).toBeLessThan(20);
  });

  it("un JSON roto es error de parseo, no de tamaño", async () => {
    await expect(readJsonBody(request(["{no es json"]), 1024)).rejects.toBeInstanceOf(
      InvalidJsonError,
    );
  });
});
