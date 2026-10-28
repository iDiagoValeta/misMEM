/**
 * Una corrida de consolidación lanzada desde la interfaz, en segundo plano.
 *
 * Tarda minutos y una petición HTTP no puede esperarla: el servidor la arranca, guarda su
 * log y su resumen, y la interfaz pregunta cómo va. Una sola a la vez: dos corridas sobre
 * los mismos episodios los destilarían dos veces y pagarían dos veces.
 */
import type { Database as DB } from "better-sqlite3";
import { loadLlmConfig, type LlmConfig } from "./llm.js";
import { runConsolidation, type RunOptions, type RunSummary } from "./run.js";

/** Lo que se guarda del log: lo último basta para ver por dónde va. */
const MAX_LOG_LINES = 200;

export interface JobState {
  running: boolean;
  scope: string | null;
  started_at: number | null;
  finished_at: number | null;
  log: string[];
  summary: RunSummary | null;
  error: string | null;
}

export class JobError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export class ConsolidationJob {
  private current: JobState = {
    running: false,
    scope: null,
    started_at: null,
    finished_at: null,
    log: [],
    summary: null,
    error: null,
  };
  private done: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DB,
    private readonly loadConfig: () => LlmConfig = loadLlmConfig,
    private readonly run: typeof runConsolidation = runConsolidation,
  ) {}

  state(): JobState {
    return { ...this.current, log: [...this.current.log] };
  }

  /** Para los tests y el apagado: espera a que termine la corrida en curso. */
  finished(): Promise<void> {
    return this.done;
  }

  start(scope?: string, extra: Partial<RunOptions> = {}): JobState {
    if (this.current.running) throw new JobError(409, "ya hay una consolidación en curso");
    let llm: LlmConfig;
    try {
      llm = this.loadConfig();
    } catch (err) {
      // Sin clave no se arranca nada: mejor decirlo ahora que tras un minuto de "en curso".
      throw new JobError(400, err instanceof Error ? err.message : String(err));
    }

    this.current = {
      running: true,
      scope: scope ?? null,
      started_at: Date.now(),
      finished_at: null,
      log: [],
      summary: null,
      error: null,
    };
    const log = (line: string): void => {
      this.current.log.push(line);
      if (this.current.log.length > MAX_LOG_LINES) this.current.log.shift();
    };

    this.done = this.run(this.db, { scopeFilter: scope, llm, log, ...extra }).then(
      (summary) => {
        this.current = { ...this.current, running: false, finished_at: Date.now(), summary };
      },
      (err: unknown) => {
        this.current = {
          ...this.current,
          running: false,
          finished_at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      },
    );
    return this.state();
  }
}
