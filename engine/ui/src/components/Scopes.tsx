import type { ScopeCount } from "../api";
import type { Loaded } from "../useLoad";

interface Props {
  state: Loaded<{ scopes: ScopeCount[] }>;
  current: string | undefined;
  onChange: (scope: string | undefined) => void;
}

export function Scopes({ state, current, onChange }: Props) {
  if (state.error) return <p className="note">No se pudieron leer los ámbitos: {state.error}</p>;
  const scopes = state.data?.scopes ?? [];
  const total = scopes.reduce((n, s) => n + s.memories, 0);

  return (
    <>
      {/* En el móvil la lista no cabe: un desplegable hace lo mismo. */}
      <select
        className="scope-select"
        value={current ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        aria-label="Ámbito"
      >
        <option value="">Toda la memoria ({total})</option>
        {scopes.map((s) => (
          <option key={s.scope} value={s.scope}>
            {s.scope} ({s.memories})
          </option>
        ))}
      </select>

      <ul className="scope-list">
        <li>
          <button className="scope" aria-current={current === undefined} onClick={() => onChange(undefined)}>
            <span className="scope-name">Toda la memoria</span>
            <span className="scope-count">{total}</span>
          </button>
        </li>
        {scopes.map((s) => (
          <li key={s.scope}>
            <button
              className="scope"
              aria-current={current === s.scope}
              onClick={() => onChange(s.scope)}
              title={`${s.memories} memorias, ${s.traits} rasgos, ${s.episodes_pending} episodios sin consolidar`}
            >
              <span className="scope-name">{s.scope}</span>
              <span className="scope-count">{s.memories}</span>
              {s.episodes_pending > 0 && (
                <span className="scope-pending" aria-label={`${s.episodes_pending} sin consolidar`}>
                  +{s.episodes_pending}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
