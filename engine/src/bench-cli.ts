#!/usr/bin/env node
/**
 * mismem-bench — mide cuántas veces el recall devuelve la memoria esperada.
 *
 * Usa el mismo recall y el mismo servidor de embeddings que producción (las
 * variables MISMEM_EMBEDDING_*), sin reforzar nada. El banco de preguntas es
 * privado: se arma desde la memoria de cada uno y no va al repo.
 */
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./db.js";
import { parseBank, runBench, type Score } from "./bench.js";

interface Args {
  db?: string;
  bank?: string;
  offTopic?: string;
  groups: string[];
  limit: number;
  json: boolean;
  help: boolean;
}

const DEFAULT_LIMIT = 5;

function parseArgs(argv: string[]): Args {
  const out: Args = { groups: [], limit: DEFAULT_LIMIT, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--bank") out.bank = argv[++i];
    else if (a === "--off-topic") out.offTopic = argv[++i];
    else if (a === "--group") out.groups = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--limit") out.limit = Number(argv[++i]) || DEFAULT_LIMIT;
  }
  return out;
}

function help(): void {
  console.log(`mismem-bench --bank <banco.jsonl> [--db <base.db>] [--limit ${DEFAULT_LIMIT}]
             [--group lang,tema] [--off-topic <ajenas.txt>] [--json]

Banco: una línea JSON por pregunta. "id" es la memoria esperada; las claves de
--group agrupan el resultado; cualquier otra clave es una variante de la pregunta:
  {"id":"01ABC...","lang":"en","parafrasis":"...","literal":"..."}
Ajenas: una pregunta por línea que NO debería traer nada.

DB: ${defaultDbPath()} (override con --db o MISMEM_DB). No refuerza ni escribe memorias.
Env: las mismas MISMEM_EMBEDDING_* que el servidor.`);
}

const percent = (score: Score): string =>
  score.total === 0 ? "sin preguntas" : `${score.found}/${score.total} (${Math.round((100 * score.found) / score.total)} %)`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.bank) {
    help();
    process.exit(args.help ? 0 : 1);
  }
  const bank = parseBank(readFileSync(args.bank, "utf8"), args.groups);
  const offTopic = args.offTopic
    ? readFileSync(args.offTopic, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const db = openDb(args.db ?? defaultDbPath());
  try {
    const report = await runBench(db, bank, { limit: args.limit, offTopic });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memoria esperada entre las ${report.limit} devueltas:`);
    for (const [variant, result] of Object.entries(report.variants)) {
      console.log(`  ${variant}: ${percent(result.all)}`);
      for (const [label, score] of Object.entries(result.groups)) {
        console.log(`    ${label}: ${percent(score)}`);
      }
    }
    if (report.offTopic.total > 0) {
      console.log(`preguntas ajenas que trajeron algo: ${report.offTopic.withHits}/${report.offTopic.total}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[bench] ${(err as Error).message}`);
  process.exit(1);
});
