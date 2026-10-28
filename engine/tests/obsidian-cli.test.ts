import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { capture, consolidate } from "../src/tools.js";

const CLI = fileURLToPath(new URL("../src/obsidian-cli.ts", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-obsidian-cli-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], dbPath: string) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, MISMEM_DB: dbPath },
    encoding: "utf8",
  });
}

describe("mismem-obsidian", () => {
  it("falla si la base no existe en vez de crearla, también con --dry-run", () => {
    const dbPath = join(dir, "no-existe.db");
    const vault = join(dir, "vault");
    const result = run(["--out", vault, "--dry-run"], dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no existe");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(vault)).toBe(false);
  });

  it("exporta con una base existente", () => {
    const dbPath = join(dir, "mem.db");
    const db = openDb(dbPath);
    const episode = capture(db, { scope: "a", body: "un episodio" }).id;
    consolidate(db, { scope: "a", gist: "una memoria", source_episode_ids: [episode] });
    db.close();

    const vault = join(dir, "vault");
    const result = run(["--out", vault], dbPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ memories: 1, scopes: 1, removed: 0 });
    expect(existsSync(join(vault, "misMEM", ".mismem-export.json"))).toBe(true);
  });
});
