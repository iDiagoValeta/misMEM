#!/usr/bin/env node
/**
 * mismem-inject — hook `UserPromptSubmit` de Claude Code: adelanta recuerdos
 * relevantes antes de que el modelo responda, sin que tenga que pedirlos.
 *
 * Busca con el prompt, descarta los ámbitos privados y lo que el contexto ya tiene,
 * y devuelve unos pocos por `additionalContext`. La búsqueda va con `reinforce:false`:
 * algo que el usuario no pidió no es uso y no puede subir la saliencia.
 *
 * Corre en cada turno, así que tiene tope de tiempo, nunca sale con error y ante
 * cualquier problema no inyecta nada: un hook que rompe no vale un recuerdo.
 */
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./db.js";
import { callRemoteTool } from "./hook-client.js";
import { serverReady } from "./hook-readiness.js";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MEMORIES,
  DEFAULT_MIN_PROMPT_TERMS,
  formatInjection,
  parseScopeList,
  selectForInjection,
  worthRecalling,
} from "./inject.js";
import type { RecallHit } from "./schema.js";
import { recallHybrid } from "./tools.js";

const DEFAULT_TIMEOUT_MS = 2500;
const STDIN_TIMEOUT_MS = 2000;
/** Cuántos recuerdos pedirle al recall antes de filtrar: el filtro descarta varios. */
const CANDIDATES = 10;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function search(query: string, timeoutMs: number): Promise<RecallHit[]> {
  const scope = process.env.MISMEM_HOOK_SCOPE || undefined;
  const args = { query, limit: CANDIDATES, reinforce: false, ...(scope ? { scope } : {}) };
  const url = process.env.MISMEM_HOOK_URL;
  if (url) {
    const dbPath = process.env.MISMEM_DB ?? defaultDbPath();
    // Un servidor sin `reinforce` descarta el campo y refuerza igual: no se le habla.
    if (!(await serverReady(url, dbPath, timeoutMs))) return [];
    const result = (await callRemoteTool(url, "recall", args, timeoutMs)) as { hits?: RecallHit[] };
    return result?.hits ?? [];
  }
  const db = openDb(process.env.MISMEM_DB ?? defaultDbPath());
  try {
    return (await recallHybrid(db, args)).hits;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const promptFlag = process.argv.indexOf("--prompt");

  let prompt = promptFlag >= 0 ? process.argv[promptFlag + 1] : undefined;
  let transcript: string | undefined;
  if (prompt === undefined) {
    const stdin = await readStdin();
    if (!stdin.trim()) return;
    const payload = JSON.parse(stdin) as { prompt?: string; transcript_path?: string };
    prompt = payload.prompt;
    transcript = payload.transcript_path;
  }
  if (!prompt?.trim()) return;

  const minTerms = envNumber("MISMEM_HOOK_MIN_PROMPT_TERMS", DEFAULT_MIN_PROMPT_TERMS);
  if (!worthRecalling(prompt, minTerms)) return;

  const hits = await search(prompt, envNumber("MISMEM_HOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));

  // Un id que ya figura en el transcript ya está en el contexto: repetirlo es pagarlo dos veces.
  let alreadyPresent = new Set<string>();
  if (transcript) {
    try {
      const raw = readFileSync(transcript, "utf8");
      alreadyPresent = new Set(hits.filter((hit) => raw.includes(hit.id)).map((hit) => hit.id));
    } catch {
      /* sin transcript legible se inyecta igual: repetir es más barato que no recordar */
    }
  }

  const chosen = selectForInjection(hits, {
    maxMemories: envNumber("MISMEM_HOOK_MAX_MEMORIES", DEFAULT_MAX_MEMORIES),
    maxChars: envNumber("MISMEM_HOOK_MAX_CHARS", DEFAULT_MAX_CHARS),
    excludeScopes: parseScopeList(process.env.MISMEM_HOOK_EXCLUDE_SCOPES),
    alreadyPresent,
  });

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify({ candidates: hits.length, injected: chosen.length, hits: chosen.map((h) => ({ id: h.id, scope: h.scope })) }, null, 2)}\n`,
    );
    return;
  }
  if (chosen.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatInjection(chosen),
      },
    })}\n`,
  );
}

main().catch((err: unknown) => {
  // Sin recuerdos se responde igual; con el turno cortado, no.
  process.stderr.write(`[mismem-inject] ${err instanceof Error ? err.message : String(err)}\n`);
});
