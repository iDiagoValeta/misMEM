import type { Database as DB } from "better-sqlite3";
import { envNonNegativeNumber, envPositiveNumber } from "../env.js";
import { embedPendingMemories } from "../embeddings/store.js";
import { distill, loadLlmConfig, LlmFatalError, type LlmConfig } from "./llm.js";
import {
  beginScope,
  hasCallsLeft,
  newRunState,
  processScope,
  type DistillFn,
  type Limits,
  type RunContext,
  type RunState,
} from "./scope.js";

export interface RunOptions {
  minAgeHours?: number;
  minEpisodesPerScope?: number;
  /** Días sin episodios nuevos tras los que un ámbito chico se consolida igual. */
  quietDays?: number;
  maxEpisodesPerBatch?: number;
  scopeFilter?: string;
  dryRun?: boolean;
  /** Si true, pre-filtra episodios L0 (Pareto) y los marca como noise sin llamar al LLM. Default true. */
  paretoPrefilter?: boolean;
  /** Tope de caracteres de episodios por llamada; lo que no entra queda para la tanda siguiente. */
  maxPromptChars?: number;
  /** Un episodio más largo que esto viaja recortado (principio y final). */
  maxEpisodeChars?: number;
  /** Tope de llamadas al LLM por corrida; lo pendiente queda para la próxima. */
  maxCalls?: number;
  /** Tandas en que el LLM puede ignorar un episodio antes de darlo por ruido. */
  uncitedStrikes?: number;
  llm?: LlmConfig;
  distillFn?: DistillFn;
  log?: (msg: string) => void;
}

export interface RunSummary {
  scopes_seen: number;
  scopes_processed: number;
  scopes_skipped_too_few: number;
  scopes_failed: number;
  episodes_consolidated: number;
  episodes_dropped_pareto_l0: number;
  /** Episodios que el LLM no logró procesar ni solos: siguen pendientes para la próxima corrida. */
  episodes_skipped: number;
  /** Episodios que el LLM leyó y no citó, con strike pendiente: vuelven en la próxima corrida. */
  episodes_uncited_pending: number;
  memories_created: number;
  llm_calls: number;
  /** El proveedor rechazó credenciales o saldo y la corrida se cortó. */
  aborted: boolean;
  errors: { scope: string; error: string }[];
  duration_ms: number;
}

// Dos semanas sin episodios nuevos: ese ámbito ya no va a juntar el mínimo (una charla vieja
// importada, un proyecto que se dejó) y sin esto quedaba pendiente para siempre.
const DEFAULT_QUIET_DAYS = 14;
// Que el LLM no cite un episodio puede ser ruido real o un olvido suyo. Darlo por ruido
// a la primera lo ponía en la fila de borrado de forget; reintentarlo cuesta los tokens
// de una tanda que ya se paga, no una llamada extra.
const DEFAULT_UNCITED_STRIKES = 3;

interface ScopeRow {
  scope: string;
  n: number;
  newest: number;
}

export async function runConsolidation(
  db: DB,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const t0 = Date.now();
  const minAgeHours = opts.minAgeHours ?? envNonNegativeNumber("MISMEM_CONSOLIDATION_MIN_AGE_HOURS", 24);
  const minEpisodes = opts.minEpisodesPerScope ?? envPositiveNumber("MISMEM_CONSOLIDATION_MIN_EPISODES", 3);
  const quietDays = opts.quietDays ?? envPositiveNumber("MISMEM_CONSOLIDATION_QUIET_DAYS", DEFAULT_QUIET_DAYS);
  const quietBefore = Date.now() - quietDays * 86_400_000;
  const uncitedStrikes = opts.uncitedStrikes ?? envPositiveNumber("MISMEM_CONSOLIDATION_UNCITED_STRIKES", DEFAULT_UNCITED_STRIKES);
  const limits: Limits = {
    maxBatch: opts.maxEpisodesPerBatch ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_BATCH", 60),
    maxPromptChars: opts.maxPromptChars ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS", 60_000),
    maxEpisodeChars: opts.maxEpisodeChars ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS", 12_000),
    maxCalls: opts.maxCalls ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_CALLS", 60),
  };
  const log = opts.log ?? ((m) => console.log(m));
  const cutoff = Date.now() - minAgeHours * 3600 * 1000;

  const summary: RunSummary = {
    scopes_seen: 0,
    scopes_processed: 0,
    scopes_skipped_too_few: 0,
    scopes_failed: 0,
    episodes_consolidated: 0,
    episodes_dropped_pareto_l0: 0,
    episodes_skipped: 0,
    episodes_uncited_pending: 0,
    memories_created: 0,
    llm_calls: 0,
    aborted: false,
    errors: [],
    duration_ms: 0,
  };

  const scopeWhere = opts.scopeFilter ? "AND scope = @scope" : "";
  const scopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n, MAX(created_at) AS newest FROM episodes
       WHERE consolidated_into IS NULL AND created_at < @cutoff ${scopeWhere}
       GROUP BY scope
       ORDER BY n DESC`,
    )
    .all({ cutoff, scope: opts.scopeFilter ?? null }) as ScopeRow[];

  summary.scopes_seen = scopes.length;
  log(`[consolidation] scopes con episodios pendientes: ${scopes.length}`);

  const ctx: RunContext = {
    db,
    cutoff,
    limits,
    llm: opts.dryRun ? null : opts.llm ?? loadLlmConfig(),
    distillFn: opts.distillFn ?? distill,
    dryRun: opts.dryRun ?? false,
    paretoPrefilter: opts.paretoPrefilter ?? true,
    log,
    uncitedStrikes,
  };
  const state: RunState = newRunState();

  const pendingIn = db.prepare(
    `SELECT COUNT(*) AS n FROM episodes
     WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff`,
  );

  for (const { scope, n, newest } of scopes) {
    if (n < minEpisodes && newest >= quietBefore) {
      summary.scopes_skipped_too_few++;
      log(`[consolidation] skip scope="${scope}" (${n} < ${minEpisodes})`);
      continue;
    }
    if (!hasCallsLeft(ctx, state)) {
      log(`[consolidation] tope de ${limits.maxCalls} llamadas: el resto queda para la próxima corrida`);
      break;
    }
    try {
      beginScope(state);
      // Tandas hasta vaciar el ámbito o llegar al tope; una tanda sin avance corta.
      for (;;) {
        const created = await processScope(ctx, state, scope);
        summary.memories_created += created.memories;
        summary.episodes_consolidated += created.episodes;
        summary.episodes_dropped_pareto_l0 += created.dropped_l0;
        if (created.episodes === 0 && !created.skipped) break;
        if ((pendingIn.get({ scope, cutoff }) as { n: number }).n === 0) break;
        if (!hasCallsLeft(ctx, state)) break;
      }
      summary.episodes_skipped += state.skipped.size;
      summary.episodes_uncited_pending += state.deferred.size;
      summary.scopes_processed++;
    } catch (err) {
      summary.scopes_failed++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ scope, error: msg });
      log(`[consolidation] ERROR scope="${scope}": ${msg}`);
      if (err instanceof LlmFatalError) {
        summary.aborted = true;
        log("[consolidation] el proveedor rechazó la clave o no hay saldo: corrida cortada");
        break;
      }
    }
  }

  // Copied here, before the backfill, so a future early return cannot report zero calls
  // on a run that already spent them.
  summary.llm_calls = state.llmCalls;

  // Backfill de embeddings para las memorias nuevas (y cualquier rezagada).
  // Opcional: si no hay Ollama, degrada sin afectar la consolidación.
  if (!ctx.dryRun) {
    try {
      const emb = await embedPendingMemories(db, { timeoutMs: 120_000, batchSize: 8 });
      if (emb.pending > 0) {
        log(`[consolidation] embeddings: pendientes=${emb.pending} embebidas=${emb.embedded} fallidas=${emb.failed}`);
      }
    } catch {
      /* la capa semántica nunca rompe el ciclo de sueño */
    }
  }

  summary.duration_ms = Date.now() - t0;
  log(
    `[consolidation] DONE en ${summary.duration_ms}ms. memorias=${summary.memories_created} episodios=${summary.episodes_consolidated} llamadas=${summary.llm_calls} fallos=${summary.scopes_failed}`,
  );
  return summary;
}
