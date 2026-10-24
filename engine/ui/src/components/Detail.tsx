import type { CSSProperties } from "react";
import { api, isMissing, type MemoryDetail, type TraitDetail } from "../api";
import type { Selection } from "../App";
import { ago, exact, ink, percent } from "../format";
import { useLoad } from "../useLoad";

interface Props {
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}

export function Detail({ selection, onSelect, onClose }: Props) {
  return (
    <article className="detail-body" data-layer={selection.layer}>
      <button className="close" onClick={onClose} aria-label="Cerrar detalle">
        Cerrar
      </button>
      {selection.layer === "memory" && <MemoryView id={selection.id} onSelect={onSelect} />}
      {selection.layer === "trait" && <TraitView id={selection.id} onSelect={onSelect} />}
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

function MemoryView({ id, onSelect }: { id: string; onSelect: Props["onSelect"] }) {
  const state = useLoad<MemoryDetail>(() => api.memory(id), [id]);
  if (state.error) return <p className="note">No se pudo cargar la memoria: {state.error}</p>;
  if (!state.data) return <p className="note" aria-busy="true">Cargando…</p>;
  const { memory, episodes, traits } = state.data;

  return (
    <>
      <p className="kind">Memoria</p>
      <p className="detail-text" style={{ "--ink-amount": ink(memory.salience) } as CSSProperties}>
        {memory.text}
      </p>
      {memory.details && memory.details !== memory.text && <p className="details">{memory.details}</p>}

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
    </>
  );
}

function TraitView({ id, onSelect }: { id: string; onSelect: Props["onSelect"] }) {
  const state = useLoad<TraitDetail>(() => api.trait(id), [id]);
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
    </>
  );
}
