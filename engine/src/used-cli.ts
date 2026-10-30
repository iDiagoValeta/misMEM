#!/usr/bin/env node
/**
 * mismem-used — hook `Stop` de Claude Code: refuerza los recuerdos que la respuesta usó.
 *
 * Lee por stdin el payload del hook (de ahí saca `transcript_path`), mira el último turno
 * y manda a `reinforce` sólo los recuerdos cuyas palabras reaparecen en la respuesta.
 *
 * Con MISMEM_HOOK_URL habla con el servidor remoto por JSON-RPC; sin ella abre la base
 * local. Nunca escribe en stdout salvo con --dry-run, y nunca sale con error: un hook que
 * rompe no vale un punto de saliencia.
 */
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./store/db.js";
import { envOptionalPositiveNumber } from "./env.js";
import { callRemoteTool, readStdin } from "./hooks/client.js";
import { reinforce } from "./memory/tools.js";
import {
  assistantReply,
  injectedMemories,
  lastTurn,
  recalledMemories,
  usedMemoryIds,
  type UsageOptions,
} from "./hooks/usage.js";

const REMOTE_TIMEOUT_MS = 5000;

function reinforceLocal(ids: string[]): void {
  const db = openDb(defaultDbPath());
  try {
    reinforce(db, { memory_ids: ids });
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const flagIndex = argv.indexOf("--transcript");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;

  // Con --transcript no hace falta stdin, y leerlo igual es colgarse esperando a nadie.
  let transcript = fromFlag;
  if (!transcript) {
    const stdin = await readStdin();
    if (!stdin.trim()) return;
    const payload = JSON.parse(stdin) as { transcript_path?: string };
    transcript = payload.transcript_path;
  }
  if (!transcript) return;

  const lines = readFileSync(transcript, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });

  const turn = lastTurn(lines);
  // Lo que el modelo pidió y lo que el hook de inyección le puso delante, sin repetir ids.
  const porId = new Map(
    [...recalledMemories(turn), ...injectedMemories(turn)].map((m) => [m.id, m]),
  );
  const memories = [...porId.values()];
  if (memories.length === 0) return;

  const opts: UsageOptions = {
    minOverlap: envOptionalPositiveNumber("MISMEM_HOOK_MIN_OVERLAP"),
    minShared: envOptionalPositiveNumber("MISMEM_HOOK_MIN_SHARED"),
  };
  const used = usedMemoryIds(memories, assistantReply(turn), opts);

  if (dryRun) {
    console.log(
      JSON.stringify({ recalled: memories.length, used: used.length, memory_ids: used }, null, 2),
    );
    return;
  }
  if (used.length === 0) return;

  const url = process.env.MISMEM_HOOK_URL;
  if (url) await callRemoteTool(url, "reinforce", { memory_ids: used }, REMOTE_TIMEOUT_MS);
  else reinforceLocal(used);
}

main().catch((err: unknown) => {
  // Un hook que falla no puede cortarle el turno a nadie: se queja y sale bien.
  process.stderr.write(`[mismem-used] ${err instanceof Error ? err.message : String(err)}\n`);
});
