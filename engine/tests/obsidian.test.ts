import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { saveMemoryEmbedding } from "../src/embeddings/store.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { EXPORT_ROOT, exportObsidian, safeName } from "../src/export/obsidian.js";

let db: DB;
let vault: string;

const manifestOf = (dir: string): { version: number; files: Record<string, { id: string; scope: string }> } =>
  JSON.parse(readFileSync(join(dir, EXPORT_ROOT, ".mismem-export.json"), "utf8"));
const scopeHash = (scope: string): string => createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 6);

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

  it("quita los caracteres de control: un NUL revienta la escritura y los demás rompen el sync", () => {
    expect(safeName("antes\u0000despues")).toBe("antes despues");
    expect(safeName("control \u0001 y \u001b escape\u007f")).toBe("control y escape");
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
    memoryFrom("a", "se queda", ["x"]);
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
  });

  it("un <palabra> del texto no corta el Markdown de la nota: se escapa", () => {
    const ids = [capture(db, { scope: "a", body: "probé fuser -k <puerto>/tcp" }).id];
    consolidate(db, { scope: "a", gist: "Mata por puerto", details: "usa fuser -k <puerto>/tcp o [s]lidev", source_episode_ids: ids });
    exportObsidian(db, { dir: vault });
    const note = read("Memorias", notes("Memorias")[0] as string);
    expect(note).toContain("usa fuser -k \\<puerto>/tcp o \\[s\\]lidev");
    expect(note).toContain("> probé fuser -k \\<puerto>/tcp");
    expect(note).not.toMatch(/[^\\]<puerto>/);
  });

  it("--dry-run cuenta sin escribir", () => {
    memoryFrom("a", "memoria", ["x"]);
    const stats = exportObsidian(db, { dir: vault, dryRun: true });
    expect(stats).toMatchObject({ dry_run: true, written: 2 });
    expect(existsSync(join(vault, EXPORT_ROOT))).toBe(false);
  });

  it("una base vacía se niega en vez de vaciar la bóveda", () => {
    memoryFrom("a", "una memoria de a", ["x"]);
    exportObsidian(db, { dir: vault });
    const memories = notes("Memorias");
    const manifest = manifestOf(vault);

    const empty = openDb(":memory:");
    try {
      expect(() => exportObsidian(empty, { dir: vault })).toThrow(
        /no hay memorias ni rasgos que exportar: no se toca la bóveda/,
      );
      // --dry-run tampoco pasa: el aviso es el mismo antes de calcular nada.
      expect(() => exportObsidian(empty, { dir: vault, dryRun: true })).toThrow(
        /no hay memorias ni rasgos que exportar/,
      );
    } finally {
      empty.close();
    }
    expect(notes("Memorias")).toEqual(memories);
    expect(manifestOf(vault)).toEqual(manifest);
  });

  it("--scope sin nada que exportar se niega y no toca las notas de otros ámbitos", () => {
    memoryFrom("a", "una memoria de a", ["x"]);
    exportObsidian(db, { dir: vault });
    const memories = notes("Memorias");
    const manifest = manifestOf(vault);

    expect(() => exportObsidian(db, { dir: vault, scope: "vacio" })).toThrow(
      /no hay memorias ni rasgos que exportar en el ámbito vacio: no se toca la bóveda/,
    );
    expect(notes("Memorias")).toEqual(memories);
    expect(manifestOf(vault)).toEqual(manifest);
  });

  it("un manifiesto ilegible detiene el export y se queda como estaba", () => {
    memoryFrom("a", "se queda", ["x"]);
    exportObsidian(db, { dir: vault });
    const memories = notes("Memorias");
    const manifestPath = join(vault, EXPORT_ROOT, ".mismem-export.json");
    writeFileSync(manifestPath, "{ roto");

    expect(() => exportObsidian(db, { dir: vault })).toThrow(/no se puede interpretar: .*\.mismem-export\.json/);
    expect(notes("Memorias")).toEqual(memories);
    // El manifiesto corrupto no se pisa: arreglarlo o borrarlo es cosa de la persona.
    expect(readFileSync(manifestPath, "utf8")).toBe("{ roto");
  });

  it("--scope no borra ni pierde las notas de los demás ámbitos", () => {
    memoryFrom("a", "una memoria de a", ["x"]);
    const b = memoryFrom("b", "una memoria de b", ["y"]);
    exportObsidian(db, { dir: vault });
    const memories = notes("Memorias");
    const scopes = notes("Ámbitos");

    const scoped = exportObsidian(db, { dir: vault, scope: "a" });
    expect(scoped).toMatchObject({ memories: 1, removed: 0, skipped: 0 });
    expect(notes("Memorias")).toEqual(memories);
    expect(notes("Ámbitos")).toEqual(scopes);
    const manifest = manifestOf(vault);
    expect(manifest.version).toBe(2);
    expect(Object.values(manifest.files).map((e) => e.scope).sort()).toEqual(["a", "a", "b", "b"]);

    // Aunque b ya no esté en la base, un export de a no puede llevarse su nota.
    db.prepare("DELETE FROM episodes WHERE consolidated_into = ?").run(b);
    db.prepare("DELETE FROM memories WHERE id = ?").run(b);
    const again = exportObsidian(db, { dir: vault, scope: "a" });
    expect(again).toMatchObject({ removed: 0 });
    expect(notes("Memorias")).toEqual(memories);
    expect(manifestOf(vault).files["Ámbitos/b.md"]).toEqual({ id: "b", scope: "b" });
  });

  it("no borra una nota ajena listada en el manifiesto", () => {
    memoryFrom("a", "se queda", ["x"]);
    exportObsidian(db, { dir: vault });
    const foreign = join(vault, EXPORT_ROOT, "Memorias", "mi nota.md");
    writeFileSync(foreign, "mía, sin id\n");
    const manifest = manifestOf(vault);
    manifest.files["Memorias/mi nota.md"] = { id: "ajeno", scope: "a" };
    writeFileSync(join(vault, EXPORT_ROOT, ".mismem-export.json"), JSON.stringify(manifest));

    const after = exportObsidian(db, { dir: vault });
    expect(after).toMatchObject({ removed: 0, skipped: 1 });
    expect(existsSync(foreign)).toBe(true);
    expect(manifestOf(vault).files["Memorias/mi nota.md"]).toBeUndefined();
  });

  it("no borra una nota exportada a la que se le cambió el id, ni un manifiesto viejo manda", () => {
    const gone = memoryFrom("a", "se va", ["x"]);
    memoryFrom("a", "se queda", ["z"]);
    exportObsidian(db, { dir: vault });
    const edited = notes("Memorias").find((n) => n.startsWith("se va")) as string;
    const editedPath = join(vault, EXPORT_ROOT, "Memorias", edited);
    writeFileSync(editedPath, read("Memorias", edited).replace(/^id: .*$/m, 'id: "editado"'));
    db.prepare("DELETE FROM episodes WHERE consolidated_into = ?").run(gone);
    db.prepare("DELETE FROM memories WHERE id = ?").run(gone);

    expect(exportObsidian(db, { dir: vault })).toMatchObject({ removed: 0, skipped: 1 });
    expect(existsSync(editedPath)).toBe(true);

    // Formato viejo (array de rutas): sin id no hay prueba de propiedad, así que no se borra.
    writeFileSync(join(vault, EXPORT_ROOT, ".mismem-export.json"), JSON.stringify([`Memorias/${edited}`]));
    const after = exportObsidian(db, { dir: vault });
    expect(after).toMatchObject({ removed: 0, skipped: 1 });
    expect(existsSync(editedPath)).toBe(true);
  });

  it("dos ámbitos que sanean al mismo nombre no comparten nota", () => {
    const long = "x".repeat(60);
    const alpha = `${long} alpha`;
    const beta = `${long} beta`;
    memoryFrom(alpha, "memoria alpha", ["a"]);
    memoryFrom(beta, "memoria beta", ["b"]);
    expect(exportObsidian(db, { dir: vault })).toMatchObject({ scopes: 2, removed: 0 });

    expect(notes("Ámbitos").sort()).toEqual(
      [`${long} (${scopeHash(alpha)}).md`, `${long} (${scopeHash(beta)}).md`].sort(),
    );
    expect(read("Ámbitos", `${long} (${scopeHash(alpha)}).md`)).toContain(`scope: "${alpha}"`);
    expect(read("Ámbitos", `${long} (${scopeHash(beta)}).md`)).toContain(`scope: "${beta}"`);
    const note = read("Memorias", notes("Memorias").find((n) => n.startsWith("memoria alpha")) as string);
    expect(note).toContain(`Ámbito: [[Ámbitos/${long} (${scopeHash(alpha)})|${alpha}]]`);

    // Exportar un solo ámbito no le quita el sufijo: la colisión se mide sobre toda la base.
    expect(exportObsidian(db, { dir: vault, scope: alpha })).toMatchObject({ written: 0, removed: 0 });
    expect(notes("Ámbitos")).toContain(`${long} (${scopeHash(alpha)}).md`);
  });

  it("un ámbito con nombre reservado de Windows lleva sufijo estable", () => {
    memoryFrom("CON", "memoria", ["x"]);
    exportObsidian(db, { dir: vault });
    expect(notes("Ámbitos")).toEqual([`CON (${scopeHash("CON")}).md`]);
    // Los que no colisionan ni son reservados se quedan como siempre.
    memoryFrom("a", "otra", ["y"]);
    exportObsidian(db, { dir: vault });
    expect(notes("Ámbitos")).toContain("a.md");
  });

  it("las etiquetas de wikilink no rompen el enlace", () => {
    const id = memoryFrom("a<b|c", "memoria", ["x"]);
    crystallize(db, { scope: "a<b|c", name: "cuida <esto> y barra \\", evidence_memory_ids: [id] });
    exportObsidian(db, { dir: vault });
    const memory = read("Memorias", notes("Memorias")[0] as string);
    expect(memory).toMatch(/\|cuida esto y barra\]\]/);
    expect(memory).toContain("[[Ámbitos/a b c|a b c]]");
    const scopeNote = read("Ámbitos", "a b c.md");
    expect(scopeNote).toContain("|cuida esto y barra]]");
  });
});
