#!/usr/bin/env node
/**
 * mismem-obsidian: exporta la memoria como bóveda de Obsidian (ver obsidian.ts).
 *
 *   mismem-obsidian --out ~/Obsidian/Memoria            # todo
 *   mismem-obsidian --out ~/Obsidian/Memoria --scope daimon --episodes
 *   mismem-obsidian --out ~/Obsidian/Memoria --dry-run  # qué cambiaría, sin escribir
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { defaultDbPath, openDb } from "./db.js";
import { EXPORT_ROOT, exportObsidian } from "./obsidian.js";

const HELP = `misMEM obsidian export

Escribe la memoria en <bóveda>/${EXPORT_ROOT}/: una nota por memoria, rasgo y ámbito,
enlazadas por origen y por parecido. Re-exportar sólo toca lo que exportó antes.

Uso:
  mismem-obsidian --out <bóveda> [opciones]

Opciones:
  --out <dir>      La bóveda de Obsidian (obligatorio)
  --scope <name>   Sólo un ámbito
  --episodes       Los episodios como notas propias, no citados dentro de su memoria
  --dry-run        Contar qué cambiaría sin escribir nada
  --help           Esta ayuda

Env:
  MISMEM_DB        default ${defaultDbPath()} (debe existir: el export no crea la base)
`;

// EX_USAGE, como el resto de CLIs que validan sus flags.
const EXIT_USAGE = 64;

function isMismemDb(path: string): boolean {
  try {
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get() !== undefined;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

function main(): void {
  let values;
  try {
    // strict: un flag mal escrito corta en vez de quedar ignorado.
    ({ values } = parseArgs({
      options: {
        out: { type: "string" },
        scope: { type: "string" },
        episodes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`[obsidian] ${(err as Error).message}\n\n${HELP}`);
    process.exit(EXIT_USAGE);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.out) {
    console.error(`[obsidian] falta --out <bóveda>\n\n${HELP}`);
    process.exit(EXIT_USAGE);
  }

  const dbPath = defaultDbPath();
  // openDb crea el fichero si falta: una ruta equivocada exportaría cero memorias y vaciaría
  // la bóveda. Mejor negarse, también en --dry-run, que no debe escribir nada.
  if (!existsSync(dbPath)) {
    console.error(`[obsidian] la base de datos no existe: ${dbPath}\n\n${HELP}`);
    process.exit(1);
  }
  // openDb migra el esquema y pasa el journal a WAL: apuntado a un SQLite que no es de misMEM,
  // lo modificaría aunque el export se negara después. Se mira antes en sólo lectura.
  if (!isMismemDb(dbPath)) {
    console.error(`[obsidian] no es una base de misMEM (no tiene la tabla memories): ${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  try {
    const stats = exportObsidian(db, {
      dir: values.out,
      scope: values.scope,
      episodes: values.episodes,
      dryRun: values["dry-run"],
    });
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error("[obsidian] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
}
