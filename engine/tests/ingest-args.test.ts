import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseIngestArgs } from "../src/ingest-args.js";

describe("parseIngestArgs", () => {
  it("sin subcomando pide ayuda", () => {
    expect(parseIngestArgs([])).toEqual({ command: "help" });
  });

  it("acepta los subcomandos y sus posicionales", () => {
    expect(parseIngestArgs(["walk", "/tmp/notas", "proyecto"])).toEqual({
      command: "walk",
      root: "/tmp/notas",
      scopePrefix: "proyecto",
    });
    expect(parseIngestArgs(["file", "/tmp/nota.md", "proyecto"])).toEqual({
      command: "file",
      path: "/tmp/nota.md",
      scope: "proyecto",
    });
    expect(parseIngestArgs(["chatgpt", "/tmp/export"])).toEqual({ command: "chatgpt", root: "/tmp/export" });
    expect(parseIngestArgs(["vscode", "/tmp/user"])).toEqual({ command: "vscode", userDir: "/tmp/user" });
    expect(parseIngestArgs(["stats"])).toEqual({ command: "stats" });
    expect(parseIngestArgs(["help"])).toEqual({ command: "help" });
    expect(parseIngestArgs(["--help"])).toEqual({ command: "help" });
    expect(parseIngestArgs(["-h"])).toEqual({ command: "help" });
  });

  it("un subcomando mal escrito corta: --wal no ingería nada", () => {
    expect(() => parseIngestArgs(["--wal", "/tmp/notas", "proyecto"])).toThrow(ArgsError);
    expect(() => parseIngestArgs(["--wal", "/tmp/notas", "proyecto"])).toThrow(/subcomando desconocido: --wal/);
  });

  it("un posicional de más corta en vez de ignorarlo", () => {
    expect(() => parseIngestArgs(["stats", "extra"])).toThrow(/argumento desconocido: extra/);
    expect(() => parseIngestArgs(["walk", "a", "b", "c"])).toThrow(/argumento desconocido: c/);
  });

  it("un valor ausente corta", () => {
    expect(() => parseIngestArgs(["walk"])).toThrow(/walk necesita 2 argumentos/);
    expect(() => parseIngestArgs(["walk", "/tmp/notas"])).toThrow(/walk necesita 2 argumentos/);
    expect(() => parseIngestArgs(["chatgpt"])).toThrow(/chatgpt necesita 1 argumento/);
  });

  it("un posicional en blanco es un valor ausente: resolve('') es el cwd", () => {
    expect(() => parseIngestArgs(["walk", "", "proyecto"])).toThrow(/walk: el argumento 1 está vacío/);
    expect(() => parseIngestArgs(["walk", "/tmp/notas", " "])).toThrow(/walk: el argumento 2 está vacío/);
    expect(() => parseIngestArgs(["chatgpt", " "])).toThrow(/chatgpt: el argumento 1 está vacío/);
  });

  it("una clave heredada de Object no es un subcomando", () => {
    expect(() => parseIngestArgs(["toString"])).toThrow(/subcomando desconocido: toString/);
    expect(() => parseIngestArgs(["constructor"])).toThrow(ArgsError);
    expect(() => parseIngestArgs(["__proto__"])).toThrow(ArgsError);
  });
});
