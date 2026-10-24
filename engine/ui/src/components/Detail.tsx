import { useState, type CSSProperties, type FormEvent } from "react";
import { actions, api, isMissing, type MemoryDetail, type TraitDetail } from "../api";
import type { Selection } from "../App";
import { ago, exact, ink, percent } from "../format";
import { useLoad } from "../useLoad";
import { Dialog } from "./Dialog";

interface Props {
  selection: Selection;
  /** Cambia cuando algo se escribió: el detalle vuelve a cargar. */
  version: number;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  /** Tras una escritura: recarga todo y, si viene, cambia la selección (null la cierra). */
  onChanged: (next?: Selection | null) => void;
}

export function Detail({ selection, version, onSelect, onClose, onChanged }: Props) {
  return (
    <article className="detail-body" data-layer={selection.layer}>
      <button className="close" onClick={onClose} aria-label="Cerrar detalle">
        Cerrar
      </button>
      {selection.layer === "memory" && (
        <MemoryView id={selection.id} version={version} onSelect={onSelect} onChanged={onChanged} />
      )}
      {selection.layer === "trait" && (
        <TraitView id={selection.id} version={version} onSelect={onSelect} onChanged={onChanged} />
      )}
      {selection.layer === "episode" && (
        <>
          <p className="kind">Episodio sin consolidar</p>
          <p className="detail-text episode-text">{selection.episode.text}</p>
          <dl className="facts">
            <dt>Ámbito</dt>
            <dd>{selection.episode.scope}</dd>
            <dt>Capturado</dt>
            <dd title={exact(selection.episode.created_at)}>{ago(selection.episode.created_at)}</dd>
          </dl>
          <p className="note">La próxima consolidación lo leerá junto con el resto de su ámbito.</p>
        </>
      )}
    </article>
  );
}

type ViewProps = Pick<Props, "version" | "onSelect" | "onChanged"> & { id: string };

function MemoryView({ id, version, onSelect, onChanged }: ViewProps) {
  const state = useLoad<MemoryDetail>(() => api.memory(id), [id, version]);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"unconsolidate" | "forget" | null>(null);
  if (state.error) return <p className="note">No se pudo cargar la memoria: {state.error}</p>;
  if (!state.data) return <p className="note" aria-busy="true">Cargando…</p>;
  const { memory, episodes, traits } = state.data;
  const linked = episodes.filter((e) => !isMissing(e) && e.linked_here).length;

  return (
    <>
      <p className="kind">Memoria</p>
      {editing ? (
        <EditForm
          gist={memory.text}
          details={memory.details}
          onCancel={() => setEditing(false)}
          onSave={async (gist, details) => {
            await actions.editMemory(memory.id, gist, details);
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <>
          <p className="detail-text" style={{ "--ink-amount": ink(memory.salience) } as CSSProperties}>
            {memory.text}
          </p>
          {memory.details && memory.details !== memory.text && <p className="details">{memory.details}</p>}
        </>
      )}

      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={memory.salience}>
        <span className="meter-label">Saliencia hoy {percent(memory.salience)}</span>
        <span className="meter-track">
          <span className="meter-fill" style={{ width: percent(memory.salience).replace(" ", "") }} />
        </span>
        <span className="meter-note">
          {memory.stored_salience !== memory.salience &&
            `guardada ${percent(memory.stored_salience)}, se reduce a la mitad cada 90 días sin uso`}
        </span>
      </div>

      <dl className="facts">
        <dt>Ámbito</dt>
        <dd>{memory.scope}</dd>
        <dt>Consolidada</dt>
        <dd title={exact(memory.created_at)}>{ago(memory.created_at)}</dd>
        <dt>Último uso</dt>
        <dd>{ago(memory.last_accessed_at)}</dd>
      </dl>

      {!editing && (
        <div className="actions" role="group" aria-label="Acciones sobre la memoria">
          <button className="button" onClick={() => setEditing(true)}>
            Corregir
          </button>
          <button className="button" onClick={() => setConfirm("unconsolidate")}>
            Deshacer consolidación
          </button>
          <button className="button danger-quiet" onClick={() => setConfirm("forget")}>
            Olvidar
          </button>
        </div>
      )}

      <section className="chain" aria-labelledby="origen">
        <h2 id="origen">De dónde sale</h2>
        {episodes.length === 0 && <p className="note">No consta ningún episodio de origen.</p>}
        <ol className="sources">
          {episodes.map((e) =>
            isMissing(e) ? (
              <li key={e.id} className="source source-missing">
                Episodio borrado por <code>forget</code>: queda el resumen, no el original.
              </li>
            ) : (
              <li key={e.id} className="source">
                <p className="source-text">{e.text}</p>
                <p className="source-meta">
                  <span title={exact(e.created_at)}>{ago(e.created_at)}</span>
                  {e.linked_here === false && <span>ahora consolidado en otra memoria</span>}
                </p>
              </li>
            ),
          )}
        </ol>
      </section>

      <section className="chain" aria-labelledby="citan">
        <h2 id="citan">Rasgos que la citan</h2>
        {traits.length === 0 ? (
          <p className="note">Ningún rasgo la cita todavía.</p>
        ) : (
          <ul className="links">
            {traits.map((t) => (
              <li key={t.id}>
                <button className="link" data-layer="trait" onClick={() => onSelect({ layer: "trait", id: t.id })}>
                  {t.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirm === "unconsolidate" && (
        <Dialog
          title="Deshacer la consolidación"
          action="Deshacer consolidación"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await actions.unconsolidate(memory.id);
            onChanged(null);
          }}
        >
          <p>
            {linked === 0
              ? "La memoria desaparece; no tenía episodios atados."
              : `La memoria desaparece y ${linked === 1 ? "su episodio vuelve" : `sus ${linked} episodios vuelven`} a estar sin consolidar. La próxima consolidación ${linked === 1 ? "lo" : "los"} leerá de nuevo.`}
          </p>
        </Dialog>
      )}
      {confirm === "forget" && (
        <Dialog
          title="Olvidar esta memoria"
          action="Olvidar"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await actions.forgetMemory(memory.id);
            onChanged(null);
          }}
        >
          <p>
            {linked === 0
              ? "Se borra la memoria."
              : `Se borran la memoria y ${linked === 1 ? "su episodio" : `sus ${linked} episodios`}.`}{" "}
            No se puede deshacer.
          </p>
          {traits.length > 0 && (
            <p>
              {traits.length === 1
                ? "Un rasgo la cita y seguirá existiendo sin ella."
                : `${traits.length} rasgos la citan y seguirán existiendo sin ella.`}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}

function EditForm({
  gist,
  details,
  onSave,
  onCancel,
}: {
  gist: string;
  details: string | null;
  onSave: (gist: string, details: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [draftGist, setDraftGist] = useState(gist);
  const [draftDetails, setDraftDetails] = useState(details ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onSave(draftGist, draftDetails.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="edit" onSubmit={submit}>
      <label>
        <span>Lo que recuerda</span>
        <textarea value={draftGist} onChange={(e) => setDraftGist(e.target.value)} rows={3} required autoFocus />
      </label>
      <label>
        <span>Detalles</span>
        <textarea value={draftDetails} onChange={(e) => setDraftDetails(e.target.value)} rows={6} />
      </label>
      {error && (
        <p className="error" role="alert">
          No se pudo guardar: {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button primary" disabled={busy || !draftGist.trim()}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function TraitView({ id, version, onSelect, onChanged }: ViewProps) {
  const state = useLoad<TraitDetail>(() => api.trait(id), [id, version]);
  const [confirm, setConfirm] = useState(false);
  if (state.error) return <p className="note">No se pudo cargar el rasgo: {state.error}</p>;
  if (!state.data) return <p className="note" aria-busy="true">Cargando…</p>;
  const { trait, evidence } = state.data;

  return (
    <>
      <p className="kind">Rasgo</p>
      <p className="detail-text">{trait.text}</p>
      <dl className="facts">
        <dt>Ámbito</dt>
        <dd>{trait.scope}</dd>
        <dt>Fuerza</dt>
        <dd>{trait.strength}</dd>
        <dt>Polaridad</dt>
        <dd>{trait.polarity}</dd>
        <dt>Actualizado</dt>
        <dd title={exact(trait.updated_at)}>{ago(trait.updated_at)}</dd>
      </dl>
      <div className="actions">
        <button className="button danger-quiet" onClick={() => setConfirm(true)}>
          Olvidar rasgo
        </button>
      </div>
      <section className="chain" aria-labelledby="sostienen">
        <h2 id="sostienen">Memorias que lo sostienen</h2>
        <ul className="links">
          {evidence.map((m) =>
            isMissing(m) ? (
              <li key={m.id} className="source-missing">
                Memoria olvidada
              </li>
            ) : (
              <li key={m.id}>
                <button
                  className="link"
                  data-layer="memory"
                  style={{ "--ink-amount": ink(m.salience) } as CSSProperties}
                  onClick={() => onSelect({ layer: "memory", id: m.id })}
                >
                  {m.text}
                </button>
              </li>
            ),
          )}
        </ul>
      </section>
      {confirm && (
        <Dialog
          title="Olvidar este rasgo"
          action="Olvidar rasgo"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await actions.forgetTrait(trait.id);
            onChanged(null);
          }}
        >
          <p>Se borra el rasgo. Las memorias que lo sostienen no se tocan. No se puede deshacer.</p>
        </Dialog>
      )}
    </>
  );
}
