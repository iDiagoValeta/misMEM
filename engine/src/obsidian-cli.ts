#!/usr/bin/env node
/**
 * mismem-obsidian: exporta la memoria como bóveda de Obsidian (ver obsidian.ts).
 *
 *   mismem-obsidian --out ~/Obsidian/Memoria            # todo
 *   mismem-obsidian --out ~/Obsidian/Memoria --scope daimon --episodes
 *   mismem-obsidian --out ~/Obsidian/Memoria --dry-run  # qué cambiaría, sin escribir
 */
import { parseArgs } from "node:util";
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
  MISMEM_DB        default ${defaultDbPath()}
`;

// EX_USAGE, como el resto de CLIs que validan sus flags.
const EXIT_USAGE = 64;

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

  const db = openDb(process.env.MISMEM_DB ?? defaultDbPath());
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
