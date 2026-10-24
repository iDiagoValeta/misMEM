import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { saveMemoryEmbedding } from "../src/embeddings/index.js";
import { capture, consolidate, crystallize } from "../src/tools.js";
import { EXPORT_ROOT, exportObsidian, safeName } from "../src/obsidian.js";

let db: DB;
let vault: string;

beforeEach(() => {
  db = openDb(":memory:");
  vault = mkdtempSync(join(tmpdir(), "mismem-vault-"));
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

function memoryFrom(scope: string, gist: string, bodies: string[], vec?: number[]): string {
  const ids = bodies.map((body) => capture(db, { scope, body }).id);
  const id = consolidate(db, { scope, gist, source_episode_ids: ids }).memory_id;
  if (vec) saveMemoryEmbedding(db, id, "m", Float32Array.from(vec));
  return id;
}

const notes = (sub: string): string[] => readdirSync(join(vault, EXPORT_ROOT, sub)).sort();
const read = (sub: string, name: string): string => readFileSync(join(vault, EXPORT_ROOT, sub, name), "utf8");

describe("safeName", () => {
  it("quita lo que Obsidian o Windows no admiten y corta por palabra", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe("a b c d e f g h i j k l m n");
    expect(safeName("una frase bastante larga que no entra", 20)).toBe("una frase bastante");
    expect(safeName("termina en punto.")).toBe("termina en punto");
    expect(safeName("///")).toBe("sin título");
  });
});

describe("exportObsidian", () => {
  it("una nota por memoria, rasgo y ámbito, enlazadas por origen, rasgo y parecido", () => {
    const a = memoryFrom("idiaval/pc", "Las luces del teclado se controlan con nitro-kb", ["probé nitro-kb y funcionó"], [1, 0]);
    const b = memoryFrom("idiaval/pc", "El portátil es un Acer Nitro", ["el portátil es un nitro"], [0.97, 0.24]);
    crystallize(db, { scope: "idiaval/pc", name: "Cuida su portátil", evidence_memory_ids: [a, b] });

    const stats = exportObsidian(db, { dir: vault });
    expect(stats).toMatchObject({ memories: 2, traits: 1, scopes: 1, written: 4, removed: 0 });
    expect(notes("Memorias")).toHaveLength(2);
    expect(notes("Ámbitos")).toEqual(["idiaval - pc.md"]);

    const note = read("Memorias", notes("Memorias").find((n) => n.startsWith("Las luces")) as string);
    expect(note).toMatch(/^---\nid: "/);
    expect(note).toContain('scope: "idiaval/pc"');
    expect(note).toContain("# Las luces del teclado se controlan con nitro-kb");
    expect(note).toContain("> probé nitro-kb y funcionó");
    expect(note).toMatch(/## Rasgos que la citan\n\n- \[\[Rasgos\/Cuida su portátil \(\w{6}\)\|Cuida su portátil\]\]/);
    expect(note).toMatch(/## Parecidas\n\n- \[\[Memorias\/El portátil es un Acer Nitro \(\w{6}\)\|El portátil es un Acer Nitro\]\] \(0\.97\)/);
    expect(note).toContain("Ámbito: [[Ámbitos/idiaval - pc|idiaval/pc]]");

    const trait = read("Rasgos", notes("Rasgos")[0] as string);
    expect(trait).toContain("strength: 2");
    expect(trait.match(/- \[\[Memorias\//g)).toHaveLength(2);
  });

  it("deja fuera el ruido y respeta el ámbito", () => {
    memoryFrom("a", "una memoria de a", ["x"]);
    memoryFrom("a", "[noise] 3 episodios sin citar", ["y"]);
    memoryFrom("b", "una memoria de b", ["z"]);
    expect(exportObsidian(db, { dir: vault, scope: "a" })).toMatchObject({ memories: 1, scopes: 1 });
    expect(notes("Memorias")).toEqual([expect.stringMatching(/^una memoria de a/)]);
  });

  it("con --episodes los episodios son notas propias enlazadas", () => {
    memoryFrom("a", "memoria", ["primer episodio", "segundo episodio"]);
    expect(exportObsidian(db, { dir: vault, episodes: true }).episodes).toBe(2);
    expect(notes("Episodios")).toHaveLength(2);
    const note = read("Memorias", notes("Memorias")[0] as string);
    expect(note.match(/- \[\[Episodios\//g)).toHaveLength(2);
    expect(read("Episodios", notes("Episodios")[0] as string)).toMatch(/Consolidado en \[\[Memorias\//);
  });

  it("re-exportar no reescribe lo que no cambió y borra sólo lo propio que ya no existe", () => {
    const keep = memoryFrom("a", "se queda", ["x"]);
    const gone = memoryFrom("a", "se va", ["y"]);
    exportObsidian(db, { dir: vault });
    // Una nota de la persona dentro de la misma carpeta no se toca nunca.
    writeFileSync(join(vault, EXPORT_ROOT, "Memorias", "mi nota.md"), "mía");
    mkdirSync(join(vault, "Diario"), { recursive: true });
    writeFileSync(join(vault, "Diario", "hoy.md"), "también mía");

    const again = exportObsidian(db, { dir: vault });
    expect(again).toMatchObject({ written: 0, removed: 0 });

    db.prepare("DELETE FROM episodes WHERE consolidated_into = ?").run(gone);
    db.prepare("DELETE FROM memories WHERE id = ?").run(gone);
    const after = exportObsidian(db, { dir: vault });
    expect(after.removed).toBe(1);
    expect(notes("Memorias")).toEqual(["mi nota.md", expect.stringMatching(/^se queda/)]);
    expect(existsSync(join(vault, "Diario", "hoy.md"))).toBe(true);
    expect(keep).toBeTruthy();
  });

  it("--dry-run cuenta sin escribir", () => {
    memoryFrom("a", "memoria", ["x"]);
    const stats = exportObsidian(db, { dir: vault, dryRun: true });
    expect(stats).toMatchObject({ dry_run: true, written: 2 });
    expect(existsSync(join(vault, EXPORT_ROOT))).toBe(false);
  });
});
