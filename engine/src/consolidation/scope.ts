/**
 * Una tanda de un ámbito: qué episodios entran, qué se le pide al LLM y qué se apunta de
 * lo que devolvió. `run.ts` la repite hasta vaciar el ámbito o gastar las llamadas.
 */
import type { Database as DB } from "better-sqlite3";
import { consolidate } from "../memory/consolidate.js";
import type { EpisodeRow } from "../store/rows.js";
import { fitPrompt } from "./budget.js";
import { classify } from "./pareto.js";
import {
  LlmInvalidJsonError,
  LlmTruncatedError,
  type DistilledMemory,
  type LlmConfig,
} from "./llm.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

export type DistillFn = (
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<DistilledMemory[]>;

export interface Limits {
  maxBatch: number;
  maxPromptChars: number;
  maxEpisodeChars: number;
  maxCalls: number;
}

/** Lo fijo de una corrida: no cambia entre ámbitos ni entre tandas. */
export interface RunContext {
  db: DB;
  cutoff: number;
  limits: Limits;
  llm: LlmConfig | null;
  distillFn: DistillFn;
  dryRun: boolean;
  paretoPrefilter: boolean;
  log: (msg: string) => void;
  uncitedStrikes: number;
}

/**
 * Lo que se gasta y lo que se da por visto. Las llamadas duran toda la corrida; el tope
 * de la tanda y los episodios ya vistos son de cada ámbito y `beginScope` los limpia.
 */
export interface RunState {
  llmCalls: number;
  /** Cuántos episodios entran en una respuesta; baja si una respuesta llega cortada. */
  cap: { episodes: number };
  /** Lo que no entró ni solo en esta corrida: no se reintenta hasta la próxima. */
  skipped: Set<string>;
  /** Lo que el LLM leyó y no citó: tampoco se repaga en esta corrida. */
  deferred: Set<string>;
}

/** Lo que una tanda aportó al resumen; `skipped` avisa de que queda algo para la próxima. */
interface ScopeOutcome {
  memories: number;
  episodes: number;
  dropped_l0: number;
  skipped?: boolean;
}

/** Only the columns the batch query selects. */
type PendingEpisodeRow = Pick<EpisodeRow, "id" | "body" | "created_at">;

export function newRunState(): RunState {
  return {
    llmCalls: 0,
    cap: { episodes: Number.POSITIVE_INFINITY },
    skipped: new Set(),
    deferred: new Set(),
  };
}

/** El gasto de llamadas no se toca: es de la corrida, no del ámbito. */
export function beginScope(state: RunState): void {
  state.cap.episodes = Number.POSITIVE_INFINITY;
  state.skipped.clear();
  state.deferred.clear();
}

/** Queda presupuesto de llamadas; `limits.maxCalls` es el tope de la corrida. */
export function hasCallsLeft(ctx: RunContext, state: RunState): boolean {
  return state.llmCalls < ctx.limits.maxCalls;
}

export async function processScope(
  ctx: RunContext,
  state: RunState,
  scope: string,
): Promise<ScopeOutcome> {
  const { db, cutoff, limits, llm, distillFn, dryRun, paretoPrefilter, log, uncitedStrikes } = ctx;
  const episodes = (
    db
      .prepare(
        `SELECT id, body, created_at FROM episodes
         WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff
         ORDER BY created_at ASC
         LIMIT @max`,
      )
      .all({ scope, cutoff, max: limits.maxBatch + state.skipped.size + state.deferred.size }) as PendingEpisodeRow[]
  )
    .filter((e) => !state.skipped.has(e.id) && !state.deferred.has(e.id))
    .slice(0, limits.maxBatch);

  if (episodes.length === 0) return { memories: 0, episodes: 0, dropped_l0: 0 };

  // Pareto pre-filter: aparta L0 (ruido) y los marca con stub para forget posterior.
  let dropped_l0 = 0;
  let candidates = episodes;
  if (paretoPrefilter && !dryRun) {
    const noise: PendingEpisodeRow[] = [];
    const keep: PendingEpisodeRow[] = [];
    const seen: string[] = [];
    for (const e of episodes) {
      const r = classify(e.body, { neighbors: seen.slice(-5) });
      if (r.level === 0) noise.push(e);
      else keep.push(e);
      seen.push(e.body);
    }
    if (noise.length > 0) {
      const stub = consolidate(db, {
        scope,
        gist: `[pareto:l0] ${noise.length} episodios filtrados por baja importancia`,
        source_episode_ids: noise.map((e) => e.id),
      });
      db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(stub.memory_id);
      dropped_l0 = noise.length;
      log(`[consolidation] scope="${scope}" pareto L0 -> ${noise.length} episodios drop`);
    }
    candidates = keep;
  }

  if (candidates.length === 0) {
    return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
  }

  // Sólo viaja lo que entra en el presupuesto; el resto queda pendiente para la tanda siguiente.
  const forPrompt = fitPrompt(candidates, {
    maxEpisodes: state.cap.episodes,
    maxPromptChars: limits.maxPromptChars,
    maxEpisodeChars: limits.maxEpisodeChars,
  });
  candidates = candidates.slice(0, forPrompt.length);

  log(`[consolidation] scope="${scope}" -> destilando ${candidates.length} episodios (post-pareto)`);

  if (dryRun || !llm) {
    log(`[consolidation] dryRun: skip LLM call`);
    return { memories: 0, episodes: 0, dropped_l0 };
  }

  if (!hasCallsLeft(ctx, state)) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
  let distilled: DistilledMemory[];
  for (;;) {
    state.llmCalls++;
    try {
      distilled = await distillFn(llm, SYSTEM_PROMPT, buildUserPrompt(scope, forPrompt));
      break;
    } catch (err) {
      const splittable = err instanceof LlmTruncatedError || err instanceof LlmInvalidJsonError;
      if (splittable && forPrompt.length === 1) {
        // Marcarlo ruido lo borraba con el próximo forget; fallar trababa el ámbito cada noche
        // contra el mismo episodio. Queda pendiente y la corrida sigue con el resto.
        const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
        log(`[consolidation] scope="${scope}" -> ${why} con 1 episodio: queda pendiente para la próxima corrida`);
        for (const e of candidates) state.skipped.add(e.id);
        // Con JSON inválido el veneno era el episodio, no el tamaño: la tanda vuelve a llenarse.
        // Con respuesta cortada el tope chico se mantiene: el modelo no entra más.
        if (err instanceof LlmInvalidJsonError) state.cap.episodes = Number.POSITIVE_INFINITY;
        return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0, skipped: true };
      }
      if (!splittable) throw err;
      state.cap.episodes = Math.floor(forPrompt.length / 2);
      forPrompt.length = state.cap.episodes;
      candidates = candidates.slice(0, state.cap.episodes);
      const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
      log(`[consolidation] scope="${scope}" -> ${why}, reintento con ${state.cap.episodes} episodios`);
      if (!hasCallsLeft(ctx, state)) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
    }
  }

  const validIds = new Set(candidates.map((e) => e.id));
  const cited = new Set<string>();
  let totalEpisodes = dropped_l0;
  let totalMemories = dropped_l0 > 0 ? 1 : 0;

  for (const m of distilled) {
    const evidence = m.evidence_episode_ids.filter((id) => validIds.has(id));
    if (evidence.length === 0) {
      log(`[consolidation] skip memoria sin evidencia v\u00e1lida: "${m.gist.slice(0, 60)}"`);
      continue;
    }
    const result = consolidate(db, {
      scope,
      gist: m.gist,
      details: m.details ?? undefined,
      source_episode_ids: evidence,
    });
    const initialSalience = m.confidence ?? 0.7;
    db.prepare("UPDATE memories SET salience = ? WHERE id = ?").run(initialSalience, result.memory_id);
    for (const id of evidence) cited.add(id);
    totalMemories++;
    totalEpisodes += result.consolidated;
  }

  // Lo que el LLM leyó y no citó puede no tener señal, o puede habérsele pasado. Cada
  // tanda sin citar suma un strike y recién al agotarlos pasa a ruido; mientras le queden,
  // vuelve en la próxima corrida. Una lista vacía ("sin señal") cuenta igual para toda la
  // tanda: antes la mandaba entera a ruido a la primera, y un mal día del modelo (o un
  // episodio que le pide devolver la lista vacía) se llevaba hasta maxBatch episodios.
  // Una respuesta con todo inventado, en cambio, deja los episodios pendientes y sin strike.
  if (distilled.length === 0) {
    log(`[consolidation] scope="${scope}" -> LLM dijo "sin se\u00f1al" para ${candidates.length} episodios: strike a todos`);
  }
  const uncited =
    distilled.length === 0 ? candidates : cited.size > 0 ? candidates.filter((e) => !cited.has(e.id)) : [];
  if (uncited.length > 0) {
    const bump = db.prepare("UPDATE episodes SET uncited_count = uncited_count + 1 WHERE id = ?");
    const strikesOf = db.prepare("SELECT uncited_count FROM episodes WHERE id = ?");
    const exhausted: PendingEpisodeRow[] = [];
    const retry: PendingEpisodeRow[] = [];
    db.transaction(() => {
      for (const e of uncited) {
        bump.run(e.id);
        const row = strikesOf.get(e.id) as { uncited_count: number };
        if (row.uncited_count >= uncitedStrikes) exhausted.push(e);
        else retry.push(e);
      }
    })();

    for (const e of retry) state.deferred.add(e.id);
    if (retry.length > 0) {
      log(`[consolidation] scope="${scope}" -> ${retry.length} sin citar con strike, vuelven en la próxima corrida`);
    }

    if (exhausted.length > 0) {
      const stub = consolidate(db, {
        scope,
        gist: `[noise] ${exhausted.length} episodio${exhausted.length === 1 ? "" : "s"} sin citar en ${uncitedStrikes} tandas`,
        source_episode_ids: exhausted.map((e) => e.id),
      });
      db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(stub.memory_id);
      totalMemories++;
      totalEpisodes += stub.consolidated;
    }
  }

  return { memories: totalMemories, episodes: totalEpisodes, dropped_l0 };
}
