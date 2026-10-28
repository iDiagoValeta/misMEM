import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-cli-usage-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Arranca el CLI de verdad: el contrato es su exit y su stderr, no lo que devuelve el parser. */
function run(cli: string, args: string[]) {
  return spawnSync("npx", ["tsx", join("src", cli), ...args], {
    cwd: ENGINE,
    env: { ...process.env, MISMEM_DB: join(dir, "mem.db") },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("exit de uso de los CLIs", () => {
  it("stats con un flag mal escrito sale con 64 y lo nombra", () => {
    const result = run("stats-cli.ts", ["--scop", "x"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("argumento desconocido");
    expect(result.stderr).toContain("--scop");
  });

  it("migrate-engram sin --source sale con 64, igual que con --source sin valor", () => {
    const missing = run("migrate-engram-cli.ts", []);
    expect(missing.status).toBe(64);
    expect(missing.stderr).toContain("falta --source");
    const noValue = run("migrate-engram-cli.ts", ["--source"]);
    expect(noValue.status).toBe(64);
    expect(noValue.stderr).toContain("--source necesita un valor");
  });
});
