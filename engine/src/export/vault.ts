// The vault on disk: the manifest, the ownership proof and the write/remove pass. Note text is
// built by `notes.ts`; this module never reads the database.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { yaml } from "./notes.js";

export const EXPORT_ROOT = "misMEM";
const MANIFEST = ".mismem-export.json";

export interface VaultOptions {
  /** La bóveda: la carpeta que abre Obsidian. */
  dir: string;
  scope?: string;
  dryRun?: boolean;
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

/** Lo que se escribe de cada nota: su contenido y lo que el manifiesto necesitará después. */
export interface WrittenFile {
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
 * Lee el manifiesto. `null` si no se puede interpretar (ilegible o con forma desconocida);
 * quien llama decide: si el fichero existe, el export se niega a seguir para no reescribirlo
 * y dejar huérfanas las notas que apuntaba. Un array es el formato viejo y se lee como
 * entradas sin id ni scope: no hay forma de demostrar que esos ficheros son nuestros.
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

export function writeVault(
  opts: VaultOptions,
  files: Map<string, WrittenFile>,
  counts: Pick<ExportStats, "memories" | "traits" | "scopes" | "episodes">,
): ExportStats {
  const root = resolve(opts.dir, EXPORT_ROOT);
  const manifestPath = join(root, MANIFEST);
  const manifestExists = existsSync(manifestPath);
  const previous = readManifest(manifestPath);
  // Escribir un manifiesto nuevo encima de uno ilegible pierde el rastro de las notas viejas
  // para siempre: ya nadie sabrá que eran nuestras y ningún export las borrará. Se para
  // antes de escribir nada; arreglarlo o borrarlo es una decisión de la persona.
  if (previous === null && manifestExists) {
    throw new Error(
      `el manifiesto no se puede interpretar: ${manifestPath}. Arréglalo o bórralo a mano: no se toca la bóveda`,
    );
  }

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
