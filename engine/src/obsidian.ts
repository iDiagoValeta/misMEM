/**
 * Exporta la memoria como bóveda de Obsidian.
 *
 * Obsidian ya resuelve navegar notas enlazadas y ver su grafo; la memoria de misMEM es
 * justo eso. Cada memoria, rasgo y ámbito es una nota, y lo que los une (de dónde sale
 * una memoria, qué rasgos la citan, a qué otras se parece) son [[enlaces]], que es lo
 * que dibuja el grafo de Obsidian.
 *
 * Todo va dentro de <bóveda>/misMEM/ y se lleva un manifiesto de lo escrito: re-exportar
 * reescribe lo suyo y borra sólo las notas propias que ya no existen, nunca algo que la
 * persona haya escrito en la bóveda. "Propia" se comprueba, no se supone: antes de borrar,
 * el frontmatter de la nota tiene que seguir declarando el id que apuntó el manifiesto.
 * Con --scope sólo se tocan las entradas de ese ámbito; las demás se conservan.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql } from "./noise.js";
import { effectiveSalience, type SalienceRow } from "./salience.js";
import { relatedLinks } from "./viewer-api.js";

export const EXPORT_ROOT = "misMEM";
const MANIFEST = ".mismem-export.json";
// Las parejas crecen con el cuadrado: por encima de esto, los parecidos se calculan sólo
// entre las memorias con más salience.
const RELATED_MAX_MEMORIES = 2000;

export interface ExportOptions {
  /** La bóveda: la carpeta que abre Obsidian. */
  dir: string;
  scope?: string;
  /** Los episodios como notas propias en vez de citados dentro de su memoria. */
  episodes?: boolean;
  dryRun?: boolean;
  at?: number;
}

export interface ExportStats {
  dir: string;
  memories: number;
  traits: number;
  scopes: number;
  episodes: number;
  written: number;
  unchanged: number;
  removed: number;
  /** Entradas del manifiesto que no se han borrado por no poder demostrar que son nuestras. */
  skipped: number;
  dry_run: boolean;
}

interface MemoryRow extends SalienceRow {
  id: string;
  scope: string;
  gist: string;
  details: string | null;
}

interface TraitRow {
  id: string;
  scope: string;
  name: string;
  strength: number;
  polarity: string;
  evidence_memory_ids: string;
  updated_at: number;
}

interface EpisodeRow {
  id: string;
  scope: string;
  body: string;
  created_at: number;
  consolidated_into: string;
}

/** Un nombre de fichero válido en Obsidian y en Windows, legible y corto. */
export function safeName(text: string, max = 60): string {
  const clean = text
    // Los caracteres de control (incluidos \n\r\t y \0) rompen la escritura, la sincronización
    // y algunos backups: un NUL en el nombre hace fallar el export entero.
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = clean.length <= max ? clean : clean.slice(0, max).replace(/\s+\S*$/, "");
  return cut.replace(/[.\s]+$/, "") || "sin título";
}

const shortId = (id: string): string => id.slice(-6);
const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** YAML entre comillas dobles: JSON es un subconjunto válido. */
const yaml = (value: string): string => JSON.stringify(value);
/**
 * Texto de un recuerdo dentro de la nota. Un `<palabra>` (p. ej. "fuser -k <puerto>/tcp")
 * Obsidian lo toma por una etiqueta HTML que abre un bloque, y todo lo que sigue deja de
 * leerse como Markdown: los enlaces de Origen salían en crudo. Un `[s]` suelto sale como
 * enlace roto. Se escapan con barra, que Obsidian muestra limpio en lectura y en edición
 * (una entidad `&lt;` se ve tal cual al editar).
 */
const text = (value: string): string => value.replace(/[<[\]]/g, (c) => `\\${c}`);
/** Una etiqueta de Obsidian no admite espacios. */
const tag = (value: string): string => value.replace(/\s+/g, "-");

function parseIds(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function exportObsidian(db: DB, opts: ExportOptions): ExportStats {
  const at = opts.at ?? Date.now();
  const scope = opts.scope;
  const memories = db
    .prepare(
      `SELECT id, scope, gist, details, salience, created_at, last_accessed_at, salience_updated_at
       FROM memories m WHERE (@scope IS NULL OR scope = @scope) AND ${excludeNoiseSql("m")}`,
    )
    .all({ scope: scope ?? null }) as MemoryRow[];
  const traits = db
    .prepare(
      `SELECT id, scope, name, strength, polarity, evidence_memory_ids, updated_at
       FROM traits WHERE (@scope IS NULL OR scope = @scope)`,
    )
    .all({ scope: scope ?? null }) as TraitRow[];
  const episodes = db
    .prepare(
      `SELECT e.id, e.scope, e.body, e.created_at, e.consolidated_into FROM episodes e
       WHERE e.consolidated_into IN (SELECT value FROM json_each(?)) ORDER BY e.created_at`,
    )
    .all(JSON.stringify(memories.map((m) => m.id))) as EpisodeRow[];

  const salience = new Map(memories.map((m) => [m.id, effectiveSalience(m, at)]));
  const memoryPath = new Map(memories.map((m) => [m.id, `Memorias/${safeName(m.gist)} (${shortId(m.id)})`]));
  const traitPath = new Map(traits.map((t) => [t.id, `Rasgos/${safeName(t.name)} (${shortId(t.id)})`]));
  const scopes = [...new Set([...memories.map((m) => m.scope), ...traits.map((t) => t.scope)])].sort();
  // Las notas de ámbito no llevan sufijo de id, así que dos ámbitos que sólo difieran por
  // truncado, mayúsculas o normalización Unicode escribirían el mismo fichero y uno
  // desaparecería sin error. El hash del scope los separa, y también desambigua los nombres
  // reservados de Windows (CON, NUL...).
  const scopeBase = (s: string): string => safeName(s.replace(/\//g, " - "));
  const scopeKey = (s: string): string => scopeBase(s).normalize("NFC").toLowerCase();
  // Las colisiones se cuentan sobre todos los ámbitos de la base, no sólo los de --scope: si
  // no, exportar un ámbito suelto le quitaría el sufijo y rompería los enlaces que le apuntan.
  const allScopes = (
    db
      .prepare(
        `SELECT scope FROM memories m WHERE ${excludeNoiseSql("m")} UNION SELECT scope FROM traits`,
      )
      .all() as Array<{ scope: string }>
  ).map((row) => row.scope);
  const scopeCount = new Map<string, number>();
  for (const s of allScopes) scopeCount.set(scopeKey(s), (scopeCount.get(scopeKey(s)) ?? 0) + 1);
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const scopePath = (s: string): string => {
    const base = scopeBase(s);
    if ((scopeCount.get(scopeKey(s)) ?? 0) === 1 && !WINDOWS_RESERVED.test(base)) return `Ámbitos/${base}`;
    const hash = createHash("sha256").update(s, "utf8").digest("hex").slice(0, 6);
    return `Ámbitos/${base} (${hash})`;
  };
  const episodePath = (e: EpisodeRow): string =>
    `Episodios/${day(e.created_at)} ${safeName(e.body, 40)} (${shortId(e.id)})`;
  // Una etiqueta de wikilink no puede contener el cierre del enlace ni partir la línea: un
  // `\` final escapaba el `]]` y un salto dejaba el enlace abierto en dos líneas.
  const linkLabel = (label: string): string => label.replace(/[[\]|\\<>]/g, " ").replace(/\s+/g, " ").trim();
  const link = (path: string, label?: string): string => (label ? `[[${path}|${linkLabel(label)}]]` : `[[${path}]]`);

  const byMemory = new Map<string, EpisodeRow[]>();
  for (const e of episodes) byMemory.set(e.consolidated_into, [...(byMemory.get(e.consolidated_into) ?? []), e]);
  const citedBy = new Map<string, TraitRow[]>();
  for (const t of traits) {
    for (const id of parseIds(t.evidence_memory_ids)) citedBy.set(id, [...(citedBy.get(id) ?? []), t]);
  }
  const relatedIds = [...memories]
    .sort((a, b) => (salience.get(b.id) ?? 0) - (salience.get(a.id) ?? 0))
    .slice(0, RELATED_MAX_MEMORIES)
    .map((m) => m.id);
  const related = new Map<string, Array<{ id: string; score: number }>>();
  for (const l of relatedLinks(db, relatedIds)) {
    related.set(l.source, [...(related.get(l.source) ?? []), { id: l.target, score: l.score ?? 0 }]);
    related.set(l.target, [...(related.get(l.target) ?? []), { id: l.source, score: l.score ?? 0 }]);
  }

  const files = new Map<string, WrittenFile>();
  const short = (text: string): string => safeName(text, 80);

  for (const m of memories) {
    const lines = [
      "---",
      `id: ${yaml(m.id)}`,
      `scope: ${yaml(m.scope)}`,
      `salience: ${(salience.get(m.id) ?? 0).toFixed(2)}`,
      `created: ${day(m.created_at)}`,
      `tags: [mismem/memoria, ${yaml(`ámbito/${tag(m.scope)}`)}]`,
      "---",
      "",
      `# ${text(m.gist)}`,
      "",
    ];
    if (m.details && m.details !== m.gist) lines.push(text(m.details), "");
    lines.push("## Origen", "");
    const sources = byMemory.get(m.id) ?? [];
    if (sources.length === 0) lines.push("Sin episodios: ya los borró `forget`.");
    for (const e of sources) {
      if (opts.episodes) lines.push(`- ${link(episodePath(e), `${day(e.created_at)} ${short(e.body)}`)}`);
      else lines.push(`> ${day(e.created_at)}`, ...text(e.body).split("\n").map((l) => `> ${l}`), "");
    }
    const citing = citedBy.get(m.id) ?? [];
    if (citing.length > 0) {
      lines.push("", "## Rasgos que la citan", "");
      for (const t of citing) lines.push(`- ${link(traitPath.get(t.id) as string, t.name)}`);
    }
    const near = (related.get(m.id) ?? []).sort((a, b) => b.score - a.score);
    if (near.length > 0) {
      lines.push("", "## Parecidas", "");
      for (const n of near) {
        const path = memoryPath.get(n.id);
        const other = memories.find((x) => x.id === n.id);
        if (path && other) lines.push(`- ${link(path, short(other.gist))} (${n.score.toFixed(2)})`);
      }
    }
    lines.push("", `Ámbito: ${link(scopePath(m.scope), m.scope)}`, "");
    files.set(`${memoryPath.get(m.id)}.md`, { content: lines.join("\n"), id: m.id, scope: m.scope });
  }

  for (const t of traits) {
    const lines = [
      "---",
      `id: ${yaml(t.id)}`,
      `scope: ${yaml(t.scope)}`,
      `strength: ${t.strength}`,
      `polarity: ${yaml(t.polarity)}`,
      `updated: ${day(t.updated_at)}`,
      `tags: [mismem/rasgo, ${yaml(`ámbito/${tag(t.scope)}`)}]`,
      "---",
      "",
      `# ${text(t.name)}`,
      "",
      "## Lo sostienen",
      "",
    ];
    for (const id of parseIds(t.evidence_memory_ids)) {
      const path = memoryPath.get(id);
      const m = memories.find((x) => x.id === id);
      lines.push(path && m ? `- ${link(path, short(m.gist))}` : `- Memoria olvidada (${id})`);
    }
    lines.push("", `Ámbito: ${link(scopePath(t.scope), t.scope)}`, "");
    files.set(`${traitPath.get(t.id)}.md`, { content: lines.join("\n"), id: t.id, scope: t.scope });
  }

  if (opts.episodes) {
    for (const e of episodes) {
      const memory = memoryPath.get(e.consolidated_into);
      const lines = [
        "---",
        `id: ${yaml(e.id)}`,
        `scope: ${yaml(e.scope)}`,
        `created: ${day(e.created_at)}`,
        "tags: [mismem/episodio]",
        "---",
        "",
        text(e.body),
        "",
        memory ? `Consolidado en ${link(memory)}` : "",
        "",
      ];
      files.set(`${episodePath(e)}.md`, { content: lines.join("\n"), id: e.id, scope: e.scope });
    }
  }

  for (const s of scopes) {
    const lines = [
      "---",
      `id: ${yaml(s)}`,
      `scope: ${yaml(s)}`,
      "tags: [mismem/ámbito]",
      "---",
      "",
      `# ${s}`,
      "",
    ];
    const ownTraits = traits.filter((t) => t.scope === s);
    if (ownTraits.length > 0) {
      lines.push("## Rasgos", "");
      for (const t of ownTraits) lines.push(`- ${link(traitPath.get(t.id) as string, t.name)}`);
      lines.push("");
    }
    lines.push("## Memorias", "");
    for (const m of memories
      .filter((x) => x.scope === s)
      .sort((a, b) => (salience.get(b.id) ?? 0) - (salience.get(a.id) ?? 0))) {
      lines.push(`- ${link(memoryPath.get(m.id) as string, short(m.gist))}`);
    }
    files.set(`${scopePath(s)}.md`, { content: `${lines.join("\n")}\n`, id: s, scope: s });
  }

  return writeVault(opts, files, {
    memories: memories.length,
    traits: traits.length,
    scopes: scopes.length,
    episodes: opts.episodes ? episodes.length : 0,
  });
}

/** Lo que se escribe de cada nota: su contenido y lo que el manifiesto necesitará después. */
interface WrittenFile {
  content: string;
  /** Id completo del recuerdo, rasgo o episodio; en una nota de ámbito, el propio scope. */
  id: string;
  scope: string;
}

interface ManifestEntry {
  id: string;
  scope: string;
}

interface Manifest {
  version: 2;
  files: Record<string, ManifestEntry>;
}

/**
 * Lee el manifiesto. `null` si no se puede interpretar (ilegible o con forma desconocida),
 * que significa "no se borra nada". Un array es el formato viejo y se lee como entradas sin
 * id ni scope: no hay forma de demostrar que esos ficheros son nuestros.
 */
function readManifest(path: string): Map<string, ManifestEntry | null> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const entries = new Map<string, ManifestEntry | null>();
  if (Array.isArray(parsed)) {
    for (const rel of parsed) if (typeof rel === "string") entries.set(rel, null);
    return entries;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const files: unknown = (parsed as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  for (const [rel, meta] of Object.entries(files as Record<string, unknown>)) {
    const entry = meta as Partial<ManifestEntry> | null;
    entries.set(
      rel,
      entry && typeof entry.id === "string" && typeof entry.scope === "string"
        ? { id: entry.id, scope: entry.scope }
        : null,
    );
  }
  return entries;
}

/** El fichero es nuestro sólo si su frontmatter sigue declarando el id que apuntó el manifiesto. */
function ownedBy(file: string, id: string): boolean {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const end = content.indexOf("\n---", 3);
  if (!content.startsWith("---\n") || end < 0) return false;
  return content.slice(4, end).split("\n").includes(`id: ${yaml(id)}`);
}

function writeVault(
  opts: ExportOptions,
  files: Map<string, WrittenFile>,
  counts: Pick<ExportStats, "memories" | "traits" | "scopes" | "episodes">,
): ExportStats {
  const root = resolve(opts.dir, EXPORT_ROOT);
  const manifestPath = join(root, MANIFEST);
  const previous = readManifest(manifestPath);

  const inside = (rel: string): string | null => {
    const file = resolve(root, rel);
    return file.startsWith(root + sep) ? file : null;
  };

  let written = 0;
  let unchanged = 0;
  for (const [rel, { content }] of files) {
    const file = inside(rel);
    if (!file) continue;
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) {
      unchanged++;
      continue;
    }
    written++;
    if (opts.dryRun) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  // El manifiesto se fusiona con el anterior, no se reemplaza: con --scope, lo exportado
  // antes para otros ámbitos sigue siendo nuestro y no puede quedar huérfano ni borrarse.
  const manifest: Manifest = { version: 2, files: {} };
  for (const [rel, { id, scope }] of files) manifest.files[rel] = { id, scope };

  let removed = 0;
  let skipped = 0;
  for (const [rel, entry] of previous ?? []) {
    if (files.has(rel)) continue;
    // Formato viejo: sin id no hay forma de distinguir nuestra nota de una de la persona.
    if (entry === null) {
      skipped++;
      continue;
    }
    if (opts.scope !== undefined && entry.scope !== opts.scope) {
      manifest.files[rel] = entry;
      continue;
    }
    const file = inside(rel);
    if (!file) continue;
    if (!existsSync(file)) {
      // La nota ya no está: la entrada sobra, igual que antes.
      removed++;
      continue;
    }
    if (!ownedBy(file, entry.id)) {
      skipped++;
      continue;
    }
    removed++;
    if (!opts.dryRun) rmSync(file, { force: true });
  }

  if (!opts.dryRun) {
    mkdirSync(root, { recursive: true });
    const sorted: Record<string, ManifestEntry> = {};
    for (const rel of Object.keys(manifest.files).sort()) sorted[rel] = manifest.files[rel] as ManifestEntry;
    writeFileSync(manifestPath, `${JSON.stringify({ version: 2, files: sorted }, null, 2)}\n`);
  }

  return { dir: root, ...counts, written, unchanged, removed, skipped, dry_run: Boolean(opts.dryRun) };
}
