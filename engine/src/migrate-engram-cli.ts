#!/usr/bin/env node
/**
 * mismem-migrate-engram CLI: migra observaciones, sessions y user_prompts
 * desde una DB SQLite de engram (engram.db) hacia mismem como episodes.
 *
 * Mapeo:
 *   engram.observations   → episodes (scope = `engram/${project||'global'}`)
 *   engram.sessions       → episodes (scope = `engram/${project||'global'}/sessions`) si tienen summary
 *   engram.user_prompts   → episodes (scope = `engram/${project||'global'}/prompts`)
 *
 * Idempotente: usa hash determinístico como id-prefix → si re-corres, salta dups.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { openDefaultDb, defaultDbPath } from "./db.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseMigrateEngramArgs } from "./migrate-engram-args.js";

interface ObsRow {
  id: number;
  type: string;
  title: string;
  content: string;
  tool_name: string | null;
  project: string | null;
  scope: string;
  topic_key: string | null;
  created_at: string;
}

interface SessionRow {
  id: string;
  project: string;
  directory: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

interface PromptRow {
  id: number;
  content: string;
  project: string | null;
  created_at: string;
}

function help(): void {
  console.log(`mismem-migrate-engram

Migra una DB de engram (sessions/observations/user_prompts) a mismem episodes.

Uso:
  mismem-migrate-engram --source /path/engram.db [opciones]

Opciones:
  --source <path>          Path a engram.db (requerido)
  --scope-prefix <name>    Prefix para scopes (default 'engram')
  --dry-run                Mostrar conteo sin escribir
  --help

Variables:
  MISMEM_DB                target DB (default ${defaultDbPath()})
`);
}

function epochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function deterministicId(salt: string): string {
  // ULID is time-ordered + random; idempotence here needs a stable hash instead.
  const hash = createHash("sha256").update(salt).digest();
  // 26 hash bytes, one per character, each reduced mod 32 to index the alphabet.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) {
    const byte = hash[i % 32] ?? 0;
    out += alphabet[byte % 32];
  }
  return out;
}

function buildScope(prefix: string, project: string | null | undefined, suffix?: string): string {
  const p = (project ?? "global").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "global";
  return suffix ? `${prefix}/${p}/${suffix}` : `${prefix}/${p}`;
}

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseMigrateEngramArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[migrate] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (opts.help) {
    help();
    return;
  }
  // Falta de un argumento obligatorio es error de uso, igual que dárselo sin valor.
  if (!opts.source) {
    console.error("[migrate] falta --source (ruta a engram.db)\n");
    help();
    process.exit(EXIT_USAGE);
  }

  const src = new Database(opts.source, { readonly: true });
  const dst = openDefaultDb();

  const observations = src
    .prepare(
      `SELECT id, type, title, content, tool_name, project, scope, topic_key, created_at
       FROM observations WHERE deleted_at IS NULL`,
    )
    .all() as ObsRow[];

  const sessions = src
    .prepare(`SELECT id, project, directory, started_at, ended_at, summary FROM sessions WHERE summary IS NOT NULL AND TRIM(summary) <> ''`)
    .all() as SessionRow[];

  const prompts = src.prepare(`SELECT id, content, project, created_at FROM user_prompts`).all() as PromptRow[];

  console.log(`[migrate] origen: ${opts.source}`);
  console.log(`[migrate] observaciones=${observations.length} sesiones(con resumen)=${sessions.length} prompts=${prompts.length}`);

  if (opts.dryRun) {
    console.log("[migrate] dry-run, saliendo");
    src.close();
    dst.close();
    return;
  }

  const insert = dst.prepare(
    `INSERT OR IGNORE INTO episodes (id, scope, body, created_at) VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;

  const tx = dst.transaction(() => {
    for (const o of observations) {
      const id = deterministicId(`engram-obs:${o.id}:${o.created_at}`);
      const scope = buildScope(opts.scopePrefix, o.project);
      const topic = o.topic_key ? ` [${o.topic_key}]` : "";
      const tool = o.tool_name ? ` (tool:${o.tool_name})` : "";
      const body = `[${o.type}]${topic}${tool} ${o.title}\n\n${o.content}`;
      const r = insert.run(id, scope, body, epochMs(o.created_at));
      if (r.changes > 0) inserted++; else skipped++;
    }
    for (const s of sessions) {
      const id = deterministicId(`engram-sess:${s.id}`);
      const scope = buildScope(opts.scopePrefix, s.project, "sessions");
      const body = `[session_summary] ${s.project} @ ${s.directory}\nStarted: ${s.started_at}${s.ended_at ? `\nEnded: ${s.ended_at}` : ""}\n\n${s.summary ?? ""}`;
      const r = insert.run(id, scope, body, epochMs(s.started_at));
      if (r.changes > 0) inserted++; else skipped++;
    }
    for (const p of prompts) {
      const id = deterministicId(`engram-prompt:${p.id}:${p.created_at}`);
      const scope = buildScope(opts.scopePrefix, p.project, "prompts");
      const body = `[user_prompt] ${p.content}`;
      const r = insert.run(id, scope, body, epochMs(p.created_at));
      if (r.changes > 0) inserted++; else skipped++;
    }
  });

  tx();
  console.log(`[migrate] HECHO insertados=${inserted} omitidos(duplicados)=${skipped}`);

  src.close();
  dst.close();
}

main().catch((err) => {
  console.error("[migrate] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
