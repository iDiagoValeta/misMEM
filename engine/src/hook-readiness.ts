/**
 * ¿El servidor ya entiende lo que el hook le va a pedir?
 *
 * `recall` acepta `reinforce` desde 0.5.0. Contra un servidor anterior, Zod descarta
 * ese campo en silencio: el hook inyectaría Y reforzaría, justo lo contrario de lo que
 * se busca. Así que antes de inyectar se confirma que el servidor expone `reinforce`.
 *
 * El resultado se cachea para no preguntar en cada turno. El "no" dura poco a propósito:
 * así el hook se enciende solo al poco tiempo de desplegar, sin que nadie se acuerde.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { remoteToolNames } from "./hook-client.js";

const READY_TTL_MS = 6 * 3_600_000;
const NOT_READY_TTL_MS = 10 * 60_000;

interface State {
  url: string;
  ready: boolean;
  checked: number;
}

function statePath(dbPath: string): string {
  return join(dirname(dbPath), "hook-readiness.json");
}

function read(path: string): State | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return undefined;
  }
}

function write(path: string, state: State): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    /* sin caché se vuelve a preguntar: molesta, no rompe */
  }
}

export function isFresh(state: State | undefined, url: string, at: number): boolean {
  if (!state || state.url !== url) return false;
  const ttl = state.ready ? READY_TTL_MS : NOT_READY_TTL_MS;
  return at - state.checked < ttl;
}

/** `probe` existe para poder testear sin red. */
export async function serverReady(
  url: string,
  dbPath: string,
  timeoutMs: number,
  opts: { at?: number; probe?: (url: string, timeoutMs: number) => Promise<string[]> } = {},
): Promise<boolean> {
  const at = opts.at ?? Date.now();
  const path = statePath(dbPath);
  const cached = read(path);
  if (isFresh(cached, url, at)) return cached!.ready;

  const probe = opts.probe ?? remoteToolNames;
  let ready = false;
  try {
    ready = (await probe(url, timeoutMs)).includes("reinforce");
  } catch {
    // Servidor caído o lento: no inyectar es más barato que inyectar mal.
    ready = false;
  }
  write(path, { url, ready, checked: at });
  return ready;
}
