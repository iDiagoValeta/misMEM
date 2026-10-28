import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseStatsArgs } from "../src/stats-args.js";

describe("parseStatsArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseStatsArgs([])).toEqual({ json: false, help: false });
  });

  it("lee los flags conocidos", () => {
    expect(parseStatsArgs(["--json", "--scope", "engram/"])).toEqual({
      json: true,
      scope: "engram/",
      help: false,
    });
    expect(parseStatsArgs(["-h"]).help).toBe(true);
  });

  it("un flag mal escrito corta: --scop mostraba el total de todos los ámbitos", () => {
    expect(() => parseStatsArgs(["--scop", "engram/"])).toThrow(ArgsError);
    expect(() => parseStatsArgs(["engram/"])).toThrow(/argumento desconocido: engram\//);
  });

  it("un valor ausente corta", () => {
    expect(() => parseStatsArgs(["--scope"])).toThrow(/--scope necesita un valor/);
    expect(() => parseStatsArgs(["--scope", "--json"])).toThrow(/--scope necesita un valor/);
  });
});
