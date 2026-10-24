import { useEffect, useRef, useState } from "react";
import { actions, api, type ConsolidationState, type ScopeCount } from "../api";

interface Props {
  scope: string | undefined;
  onClose: () => void;
  /** La corrida terminó: hay memorias nuevas que mostrar. */
  onFinished: () => void;
}

const POLL_MS = 2000;

/**
 * Consolidar ahora: confirma, arranca la corrida en el servidor y enseña cómo va. Si al
 * abrirlo ya hay una en curso (lanzada desde otra pestaña), muestra esa en vez de otra.
 */
export function Consolidate({ scope, onClose, onFinished }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [job, setJob] = useState<ConsolidationState>();
  const [scopes, setScopes] = useState<ScopeCount[]>();
  const [onlyScope, setOnlyScope] = useState(Boolean(scope));
  const [error, setError] = useState<string>();
  const [startedHere, setStartedHere] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    api.consolidation().then(setJob, (err: unknown) => setError(String(err)));
    api.scopes().then(({ scopes: list }) => setScopes(list), () => undefined);
  }, []);

  // Mientras corre, se pregunta cada dos segundos; al terminar, se avisa una vez.
  useEffect(() => {
    if (!job?.running) return;
    const timer = setInterval(() => {
      api.consolidation().then((next) => {
        setJob(next);
        if (!next.running) onFinished();
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job?.running, onFinished]);

  const pendingInScope = scopes
    ?.filter((s) => !(onlyScope && scope) || s.scope === scope)
    .reduce((n, s) => n + s.episodes_pending, 0);

  const start = async () => {
    setError(undefined);
    try {
      setJob(await actions.consolidate(onlyScope ? scope : undefined));
      setStartedHere(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const phase = !job ? "loading" : job.running ? "running" : job.finished_at && startedHere ? "done" : "confirm";

  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} aria-labelledby="consolidate-title">
      <h2 id="consolidate-title">Consolidar ahora</h2>

      {phase === "loading" && <p className="note">Comprobando si ya hay una en curso…</p>}

      {phase === "confirm" && (
        <div className="dialog-body">
          <p>
            Un LLM lee los episodios sin consolidar y los resume en memorias. Cada tanda es una llamada a la API
            del proveedor configurado en el servidor, así que cuesta dinero; los topes de la consolidación siguen
            valiendo.
          </p>
          {pendingInScope !== undefined && (
            <p>
              Hay {pendingInScope === 1 ? "1 episodio" : `${pendingInScope} episodios`} sin consolidar. Los de menos de un
              día esperan a la próxima.
            </p>
          )}
          {scope && (
            <label className="radio">
              <input type="checkbox" checked={onlyScope} onChange={(e) => setOnlyScope(e.target.checked)} />
              Sólo el ámbito {scope}
            </label>
          )}
        </div>
      )}

      {(phase === "running" || phase === "done") && job && (
        <div className="dialog-body">
          <p>
            {job.running
              ? `En curso${job.scope ? ` en ${job.scope}` : ""}. Puedes cerrar esto: sigue en el servidor.`
              : job.error
                ? `Falló: ${job.error}`
                : "Terminó."}
          </p>
          {job.summary && (
            <dl className="facts">
              <dt>Memorias nuevas</dt>
              <dd>{job.summary.memories_created}</dd>
              <dt>Episodios consolidados</dt>
              <dd>{job.summary.episodes_consolidated}</dd>
              <dt>Llamadas al LLM</dt>
              <dd>{job.summary.llm_calls}</dd>
              <dt>Ámbitos con error</dt>
              <dd>{job.summary.scopes_failed}</dd>
            </dl>
          )}
          <pre className="job-log" aria-live="polite">
            {job.log.slice(-10).join("\n") || "Esperando la primera línea…"}
          </pre>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          No se pudo: {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => ref.current?.close()}>
          {phase === "confirm" ? "Cancelar" : "Cerrar"}
        </button>
        {phase === "confirm" && (
          <button type="button" className="button primary" onClick={start}>
            Consolidar ahora
          </button>
        )}
      </div>
    </dialog>
  );
}
