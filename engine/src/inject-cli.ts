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
import { defaultDbPath, openDb } from "./store/db.js";
import { envPositiveNumber } from "./env.js";
import { callRemoteTool, readStdin } from "./hooks/client.js";
import { serverReady } from "./hooks/readiness.js";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MEMORIES,
  DEFAULT_MIN_PROMPT_TERMS,
  formatInjection,
  parseScopeList,
  selectForInjection,
  worthRecalling,
} from "./hooks/inject.js";
import type { RecallHit } from "./schema.js";
import { recallHybrid } from "./recall/recall.js";

const DEFAULT_TIMEOUT_MS = 2500;
/** Cuántos recuerdos pedirle al recall antes de filtrar: el filtro descarta varios. */
const CANDIDATES = 10;

async function search(query: string, timeoutMs: number): Promise<RecallHit[]> {
  const scope = process.env.MISMEM_HOOK_SCOPE || undefined;
  const args = { query, limit: CANDIDATES, reinforce: false, ...(scope ? { scope } : {}) };
  const url = process.env.MISMEM_HOOK_URL;
  if (url) {
    const dbPath = defaultDbPath();
    // Un servidor sin `reinforce` descarta el campo y refuerza igual: no se le habla.
    if (!(await serverReady(url, dbPath, timeoutMs))) return [];
    const result = (await callRemoteTool(url, "recall", args, timeoutMs)) as { hits?: RecallHit[] };
    return result?.hits ?? [];
  }
  const db = openDb(defaultDbPath());
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

  const minTerms = envPositiveNumber("MISMEM_HOOK_MIN_PROMPT_TERMS", DEFAULT_MIN_PROMPT_TERMS);
  if (!worthRecalling(prompt, minTerms)) return;

  const hits = await search(prompt, envPositiveNumber("MISMEM_HOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));

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
    maxMemories: envPositiveNumber("MISMEM_HOOK_MAX_MEMORIES", DEFAULT_MAX_MEMORIES),
    maxChars: envPositiveNumber("MISMEM_HOOK_MAX_CHARS", DEFAULT_MAX_CHARS),
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
