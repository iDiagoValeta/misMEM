import type { CSSProperties, ReactNode } from "react";
import { api, type Layer } from "../api";
import type { Selection } from "../App";
import { ago, ink, percent } from "../format";
import { useLoad, type Loaded } from "../useLoad";

interface ListProps {
  scope: string | undefined;
  /** Cambia cuando algo se escribió: la lista vuelve a cargar. */
  version: number;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}

/** Selección para cristalizar: id → ámbito, para exigir que sean del mismo. */
export type Picked = ReadonlyMap<string, string>;

const LAYER_NAME: Record<Layer, string> = { episode: "episodio", memory: "memoria", trait: "rasgo" };

function Rows<T>({ state, empty, children }: { state: Loaded<T>; empty: string; children: (data: T) => ReactNode[] }) {
  if (state.error) return <p className="note">No se pudo cargar: {state.error}</p>;
  if (!state.data) return <p className="note" aria-busy="true">Cargando…</p>;
  const rows = children(state.data);
  if (rows.length === 0) return <p className="note">{empty}</p>;
  return <ul className="rows">{rows}</ul>;
}

function Row({
  layer,
  active,
  salience,
  onClick,
  text,
  meta,
  pick,
}: {
  layer: Layer;
  active: boolean;
  salience?: number;
  onClick: () => void;
  text: string;
  meta: ReactNode;
  pick?: { checked: boolean; onChange: () => void };
}) {
  return (
    <li className={pick ? "picking" : undefined}>
      {pick && (
        <input
          type="checkbox"
          className="pick"
          checked={pick.checked}
          onChange={pick.onChange}
          aria-label={`Seleccionar: ${text.slice(0, 80)}`}
        />
      )}
      <button
        className="row"
        data-layer={layer}
        aria-current={active}
        onClick={onClick}
        style={{ "--ink-amount": ink(salience) } as CSSProperties}
      >
        <span className="row-text">{text}</span>
        <span className="row-meta">{meta}</span>
      </button>
    </li>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function MemoryList({
  scope,
  version,
  selected,
  onSelect,
  picked,
  onPick,
}: ListProps & { picked?: Picked; onPick?: (id: string, scope: string) => void }) {
  const state = useLoad(() => api.memories(scope), [scope, version]);
  return (
    <Rows state={state} empty="Todavía no hay memorias consolidadas en este ámbito.">
      {(data) =>
        data.memories.map((m) => (
          <Row
            key={m.id}
            layer="memory"
            active={selected?.layer === "memory" && selected.id === m.id}
            salience={m.salience}
            onClick={() => onSelect({ layer: "memory", id: m.id })}
            pick={picked && onPick ? { checked: picked.has(m.id), onChange: () => onPick(m.id, m.scope) } : undefined}
            text={m.text}
            meta={
              <>
                <span>{m.scope}</span>
                <span>{ago(m.created_at)}</span>
                <span>{plural(m.sources ?? 0, "fuente", "fuentes")}</span>
                {(m.traits ?? 0) > 0 && <span>{plural(m.traits ?? 0, "rasgo la cita", "rasgos la citan")}</span>}
                <span className="salience" title="Saliencia hoy">
                  {percent(m.salience)}
                </span>
              </>
            }
          />
        ))
      }
    </Rows>
  );
}

export function TraitList({ scope, version, selected, onSelect }: ListProps) {
  const state = useLoad(() => api.traits(scope), [scope, version]);
  return (
    <Rows state={state} empty="Ningún patrón se ha cristalizado como rasgo todavía.">
      {(data) =>
        data.rows.map((t) => (
          <Row
            key={t.id}
            layer="trait"
            active={selected?.layer === "trait" && selected.id === t.id}
            onClick={() => onSelect({ layer: "trait", id: t.id })}
            text={t.text}
            meta={
              <>
                <span>{t.scope}</span>
                <span>fuerza {t.strength}</span>
                {t.polarity !== "neutral" && <span>{t.polarity}</span>}
                <span>{ago(t.updated_at)}</span>
              </>
            }
          />
        ))
      }
    </Rows>
  );
}

export function EpisodeList({ scope, version, selected, onSelect }: ListProps) {
  const state = useLoad(() => api.episodes(scope), [scope, version]);
  return (
    <Rows state={state} empty="Nada pendiente: todo lo capturado ya pasó por la consolidación.">
      {(data) =>
        data.rows
          .filter((e) => !e.consolidated_into)
          .map((e) => (
            <Row
              key={e.id}
              layer="episode"
              active={selected?.layer === "episode" && selected.id === e.id}
              onClick={() => onSelect({ layer: "episode", id: e.id, episode: e })}
              text={e.text}
              meta={
                <>
                  <span>{e.scope}</span>
                  <span>{ago(e.created_at)}</span>
                </>
              }
            />
          ))
      }
    </Rows>
  );
}

export function SearchResults({ query, scope, version, selected, onSelect }: ListProps & { query: string }) {
  const state = useLoad(() => api.search(query, scope), [query, scope, version]);
  return (
    <>
      <p className="search-heading">
        Resultados para <q>{query}</q>
        {scope ? ` en ${scope}` : ""}
      </p>
      <Rows state={state} empty="Nada coincide. Prueba con otras palabras o en toda la memoria.">
        {(data) =>
          data.hits.map((h) => (
            <Row
              key={`${h.layer}-${h.id}`}
              layer={h.layer}
              active={selected?.id === h.id}
              salience={h.layer === "memory" ? h.salience : undefined}
              onClick={() =>
                onSelect(
                  h.layer === "episode"
                    ? { layer: "episode", id: h.id, episode: { id: h.id, scope: h.scope, text: h.text, created_at: h.created_at } }
                    : { layer: h.layer, id: h.id },
                )
              }
              text={h.text}
              meta={
                <>
                  <span className="layer-name">{LAYER_NAME[h.layer]}</span>
                  <span>{h.scope}</span>
                  <span>{ago(h.created_at)}</span>
                  {h.via === "semantic" && <span title="Encontrada por significado, no por palabras">por significado</span>}
                </>
              }
            />
          ))
        }
      </Rows>
    </>
  );
}
