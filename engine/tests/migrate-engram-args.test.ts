import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseMigrateEngramArgs } from "../src/migrate-engram-args.js";

describe("parseMigrateEngramArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseMigrateEngramArgs([])).toEqual({
      source: "",
      dryRun: false,
      scopePrefix: "engram",
      help: false,
    });
  });

  it("lee los flags conocidos", () => {
    expect(parseMigrateEngramArgs(["--source", "/tmp/engram.db", "--scope-prefix", "old", "--dry-run"])).toEqual({
      source: "/tmp/engram.db",
      dryRun: true,
      scopePrefix: "old",
      help: false,
    });
    expect(parseMigrateEngramArgs(["-h"]).help).toBe(true);
  });

  it("un flag mal escrito corta: --dryrun migraba de verdad", () => {
    expect(() => parseMigrateEngramArgs(["--source", "x.db", "--dryrun"])).toThrow(ArgsError);
    expect(() => parseMigrateEngramArgs(["x.db"])).toThrow(/argumento desconocido: x\.db/);
  });

  it("un valor ausente corta", () => {
    expect(() => parseMigrateEngramArgs(["--source"])).toThrow(/--source necesita un valor/);
    expect(() => parseMigrateEngramArgs(["--scope-prefix"])).toThrow(/--scope-prefix necesita un valor/);
  });
});
