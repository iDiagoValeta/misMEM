import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseEmbedArgs } from "../src/embed-args.js";

describe("parseEmbedArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseEmbedArgs([])).toEqual({ batch: 32, status: false, force: false, help: false });
  });

  it("lee los flags conocidos", () => {
    expect(parseEmbedArgs(["--scope", "daimon", "--batch", "16", "--force"])).toEqual({
      scope: "daimon",
      batch: 16,
      status: false,
      force: true,
      help: false,
    });
    expect(parseEmbedArgs(["--stats"]).status).toBe(true);
    expect(parseEmbedArgs(["--status"]).status).toBe(true);
    expect(parseEmbedArgs(["-h"]).help).toBe(true);
  });

  it("un flag mal escrito corta: --scop reindexaba todo en silencio", () => {
    expect(() => parseEmbedArgs(["--scop", "daimon"])).toThrow(ArgsError);
    expect(() => parseEmbedArgs(["daimon"])).toThrow(/argumento desconocido: daimon/);
  });

  it("un valor ausente corta", () => {
    expect(() => parseEmbedArgs(["--scope"])).toThrow(/--scope necesita un valor/);
    expect(() => parseEmbedArgs(["--batch"])).toThrow(/--batch necesita un valor/);
    expect(() => parseEmbedArgs(["--batch", "--force"])).toThrow(/--batch necesita un valor/);
  });

  it("un batch inválido corta en vez de caer a 32", () => {
    expect(() => parseEmbedArgs(["--batch", "abc"])).toThrow(/no es un número/);
    expect(() => parseEmbedArgs(["--batch", "0"])).toThrow(/>= 1/);
    expect(() => parseEmbedArgs(["--batch", "2.5"])).toThrow(/entero/);
  });
});
