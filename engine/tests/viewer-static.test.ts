import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { serveUi } from "../src/viewer-static.js";

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string | Buffer): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload === undefined ? "" : payload.toString();
    },
  };
}

function serve(pathname: string, dir: string): MockResponse {
  const res = mockRes();
  serveUi(res as unknown as ServerResponse, pathname, dir);
  return res;
}

let root: string;
let ui: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mismem-ui-"));
  ui = join(root, "ui");
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>misMEM</title>");
  writeFileSync(join(ui, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(ui, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(root, "secreto.txt"), "no");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("viewer-static: serveUi", () => {
  it("sirve el index en /, /viewer y /viewer/ con CSP estricta y sin caché", () => {
    for (const path of ["/", "/viewer", "/viewer/"]) {
      const res = serve(path, ui);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
      expect(res.headers["content-security-policy"]).toMatch(/script-src 'self'/);
      expect(res.body).toContain("<title>misMEM</title>");
    }
  });

  it("sirve los assets con su tipo y caché larga", () => {
    const js = serve("/viewer/assets/index-abc123.js", ui);
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/text\/javascript/);
    expect(js.headers["cache-control"]).toMatch(/immutable/);
    expect(serve("/viewer/assets/index-abc123.css", ui).headers["content-type"]).toMatch(/text\/css/);
  });

  it("no sale de dist/ui, ni con .. codificado", () => {
    expect(serve("/viewer/../secreto.txt", ui).statusCode).toBe(404);
    expect(serve("/viewer/%2e%2e/secreto.txt", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets/%2e%2e%2f..%2fsecreto.txt", ui).statusCode).toBe(404);
  });

  it("un asset que no existe es 404", () => {
    expect(serve("/viewer/assets/nada.js", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets/%E0%A4%A", ui).statusCode).toBe(404);
  });

  it("sin la interfaz compilada dice cómo compilarla", () => {
    const res = serve("/viewer", join(root, "no-existe"));
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/pnpm build/);
  });
});
