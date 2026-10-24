import { describe, it, expect } from "vitest";
import { ArgsError, parseForgetArgs } from "../src/forget-args.js";

describe("parseForgetArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseForgetArgs([])).toEqual({
      beforeDays: 90,
      memoryGraceDays: 30,
      salienceBelow: 0.1,
      dryRun: false,
      help: false,
    });
  });

  it("lee los flags conocidos", () => {
    expect(
      parseForgetArgs([
        "--dry-run",
        "--scope",
        "proyecto",
        "--before-days",
        "60",
        "--memory-grace-days",
        "10",
        "--salience-below",
        "0.2",
      ]),
    ).toEqual({
      scope: "proyecto",
      beforeDays: 60,
      memoryGraceDays: 10,
      salienceBelow: 0.2,
      dryRun: true,
      help: false,
    });
  });

  it("un flag mal escrito corta en vez de dejar correr la purga real", () => {
    for (const typo of ["--dryrun", "-n", "--dry-run=true", "--dry_run"]) {
      expect(() => parseForgetArgs(["--before-days", "90", typo])).toThrow(ArgsError);
    }
  });

  it("un flag sin valor corta: --scope vacío purgaría todos los ámbitos", () => {
    expect(() => parseForgetArgs(["--scope"])).toThrow(/--scope necesita un valor/);
    expect(() => parseForgetArgs(["--scope", "--dry-run"])).toThrow(/--scope necesita un valor/);
    expect(() => parseForgetArgs(["--before-days"])).toThrow(ArgsError);
  });

  it("un número que no es número corta", () => {
    expect(() => parseForgetArgs(["--salience-below", "abc"])).toThrow(/no es un número/);
    expect(() => parseForgetArgs(["--before-days", ""])).toThrow(/no es un número/);
  });
});
