/**
 * Escrituras desde la interfaz: corregir, deshacer una consolidación, olvidar y cristalizar.
 *
 *   POST /api/memory/:id/edit           {gist, details?}
 *   POST /api/memory/:id/unconsolidate  la memoria se borra y sus episodios vuelven a pendientes
 *   POST /api/memory/:id/forget         la memoria y sus episodios se borran (en dos pasos)
 *   POST /api/trait/:id/forget          el rasgo se borra (en dos pasos)
 *   POST /api/crystallize               {scope, name, polarity?, evidence_memory_ids}
 *   POST /api/consolidate               {scope?}: arranca una corrida en segundo plano
 *
 * Hasta acá toda la API del viewer era GET y la seguridad se apoyaba en eso. Una escritura
 * pide además (writeGuard): POST con cuerpo JSON, que desde otro origen obliga a un preflight
 * CORS que el servidor no contesta, y un Origin igual al propio servidor, que corta un
 * formulario o un fetch desde otra web. La auth y el filtro de Host de server-http siguen
 * delante, y el filtro de Host es el que cubre el DNS rebinding.
 *
 * Los dos forget no tienen vuelta atrás y el de memoria borra también la evidencia, sus
 * episodios (deshacer la consolidación borra el resumen, pero los episodios vuelven), así que piden
 * más: sólo existen con MISMEM_VIEWER_ALLOW_DELETE encendido (si no, 403), y el primer POST
 * no borra. Responde 409 con lo que se perdería y un token de un solo uso, ligado a ese id y
 * válido 60 s; borra el segundo POST, el que trae {confirm_token}. Así la UI tiene que enseñar
 * el impacto antes de preguntar, y un request forjado suelto no alcanza.
 *
 * Las escrituras y su SQL viven en engine/src/memory/edit.ts; el impacto que se enseña antes
 * de confirmar y los ámbitos que valida la evidencia, en engine/src/queries/.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { CrystallizeInput, Scope } from "../../schema.js";
import { crystallize } from "../../memory/crystallize.js";
import {
  editMemory,
  forgetMemory,
  forgetTrait,
  unconsolidateMemory,
  type Reembed,
} from "../../memory/edit.js";
import { forgetImpact } from "../../queries/forget-impact.js";
import { entityExists, memoryScopes } from "../../queries/memories.js";
import { JobError, type ConsolidationJob } from "../../consolidation/job.js";
import { json } from "../respond.js";

/** Una acción no necesita más: lo grande va por capture o la ingesta. */
export const ACTION_MAX_BODY_BYTES = 256 * 1024;

/** Por qué se rechaza una escritura, o null si pasa. */
export function writeGuard(req: IncomingMessage): { status: number; error: string } | null {
  if (req.method !== "POST") return { status: 405, error: "las acciones van por POST" };
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { status: 415, error: "las acciones llevan cuerpo application/json" };
  }
  const origin = req.headers.origin;
  if (!origin) return { status: 403, error: "falta Origin" };
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { status: 403, error: "Origin inválido" };
  }
  if (originHost !== req.headers.host) return { status: 403, error: "Origin ajeno" };
  return null;
}

const CONFIRM_TTL_SECONDS = 60;

/** Tokens de confirmación de los forget: de un solo uso, ligados a la capa y el id, con TTL. */
export class ForgetConfirmations {
  private readonly pending = new Map<string, { target: string; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  issue(layer: string, id: string): string {
    const at = this.clock();
    for (const [token, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(token);
    const token = randomBytes(16).toString("hex");
    this.pending.set(token, { target: `${layer}/${id}`, expiresAt: at + CONFIRM_TTL_SECONDS * 1000 });
    return token;
  }

  /** true si el token vale para esta capa e id. Lo gasta siempre, valga o no. */
  consume(token: string, layer: string, id: string): boolean {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    return entry !== undefined && entry.target === `${layer}/${id}` && entry.expiresAt > this.clock();
  }
}

/** El interruptor del borrado desde la interfaz: apagado salvo que se encienda a propósito. */
export function loadAllowDelete(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on"].includes((env.MISMEM_VIEWER_ALLOW_DELETE ?? "").trim().toLowerCase());
}

const ConfirmInput = z.object({ confirm_token: z.string().min(1).max(128).optional() });

/** Como la tool `crystallize`, pero sin aceptar memorias que no existen o de otro ámbito. */
export function crystallizeFromUi(db: DB, raw: unknown): ReturnType<typeof crystallize> {
  const input = CrystallizeInput.parse(raw);
  const ids = [...new Set(input.evidence_memory_ids)];
  const found = memoryScopes(db, ids);
  const missing = ids.filter((id) => !found.some((m) => m.id === id));
  if (missing.length > 0) throw new ActionError(400, `memorias que no existen: ${missing.join(", ")}`);
  const foreign = found.filter((m) => m.scope !== input.scope).map((m) => m.id);
  if (foreign.length > 0) throw new ActionError(400, `memorias de otro ámbito: ${foreign.join(", ")}`);
  return crystallize(db, { ...input, evidence_memory_ids: ids });
}

class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

const ROUTE = /^\/api\/(memory|trait)\/([^/]+)\/(edit|unconsolidate|forget)$/;

/**
 * Despacha una acción ya autorizada (writeGuard) con su cuerpo leído. Devuelve false si la
 * ruta no es una acción, para que el llamador siga con su 404.
 */
export async function handleAction(
  db: DB,
  res: ServerResponse,
  pathname: string,
  body: unknown,
  opts: {
    reembed?: Reembed;
    job?: ConsolidationJob;
    allowDelete?: boolean;
    confirmations?: ForgetConfirmations;
  } = {},
): Promise<boolean> {
  try {
    if (pathname === "/api/consolidate" && opts.job) {
      const scope = z.object({ scope: Scope.optional() }).parse(body ?? {}).scope;
      json(res, 202, opts.job.start(scope));
      return true;
    }
    if (pathname === "/api/crystallize") {
      json(res, 200, crystallizeFromUi(db, body));
      return true;
    }
    const match = ROUTE.exec(pathname);
    if (!match) return false;
    const [, layer, rawId, action] = match;
    const id = decodeURIComponent(rawId ?? "");
    const target = layer === "trait" ? "trait" : "memory";
    if (!entityExists(db, target, id)) {
      json(res, 404, { error: `no existe ${target === "trait" ? "el rasgo" : "la memoria"}: ${id}` });
      return true;
    }
    if (target === "trait" && action !== "forget") return false;
    if (action === "edit") json(res, 200, await editMemory(db, id, body, opts.reembed));
    else if (action === "unconsolidate") json(res, 200, unconsolidateMemory(db, id));
    else {
      if (!opts.allowDelete || !opts.confirmations) {
        json(res, 403, {
          error: "borrar desde la interfaz está desactivado: arranca el servidor con MISMEM_VIEWER_ALLOW_DELETE=1",
        });
        return true;
      }
      const token = ConfirmInput.parse(body ?? {}).confirm_token;
      if (!token || !opts.confirmations.consume(token, target, id)) {
        json(res, 409, {
          ...(token ? { error: "la confirmación caducó o no es de este recuerdo; confirma otra vez" } : {}),
          confirm_token: opts.confirmations.issue(target, id),
          expires_in: CONFIRM_TTL_SECONDS,
          impact: forgetImpact(db, target, id),
        });
        return true;
      }
      json(res, 200, target === "trait" ? forgetTrait(db, id) : forgetMemory(db, id));
    }
    return true;
  } catch (err) {
    if (err instanceof ActionError || err instanceof JobError) json(res, err.status, { error: err.message });
    else if (err instanceof z.ZodError) json(res, 400, { error: err.issues.map((i) => i.message).join("; ") });
    else throw err;
    return true;
  }
}
