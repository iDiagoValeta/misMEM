import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseBenchArgs } from "../src/bench-args.js";

describe("parseBenchArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseBenchArgs([])).toEqual({ groups: [], limit: 5, json: false, help: false });
  });

  it("lee los flags conocidos", () => {
    expect(
      parseBenchArgs([
        "--bank",
        "banco.jsonl",
        "--db",
        "/tmp/mem.db",
        "--off-topic",
        "ajenas.txt",
        "--group",
        "lang,en",
        "--limit",
        "3",
        "--json",
      ]),
    ).toEqual({
      bank: "banco.jsonl",
      db: "/tmp/mem.db",
      offTopic: "ajenas.txt",
      groups: ["lang", "en"],
      limit: 3,
      json: true,
      help: false,
    });
    expect(parseBenchArgs(["-h"]).help).toBe(true);
  });

  it("un flag mal escrito corta: --jsn dejaba la salida en texto", () => {
    expect(() => parseBenchArgs(["--bank", "b.jsonl", "--jsn"])).toThrow(ArgsError);
    expect(() => parseBenchArgs(["b.jsonl"])).toThrow(/argumento desconocido: b.jsonl/);
  });

  it("un valor ausente corta", () => {
    expect(() => parseBenchArgs(["--bank"])).toThrow(/--bank necesita un valor/);
    expect(() => parseBenchArgs(["--group"])).toThrow(/--group necesita un valor/);
    expect(() => parseBenchArgs(["--limit"])).toThrow(/--limit necesita un valor/);
  });

  it("un limit inválido corta en vez de caer a 5", () => {
    expect(() => parseBenchArgs(["--bank", "b.jsonl", "--limit", "abc"])).toThrow(/no es un número/);
    expect(() => parseBenchArgs(["--bank", "b.jsonl", "--limit", "0"])).toThrow(/>= 1/);
  });
});
