import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { actions, api, type EpisodeItem, type Polarity } from "./api";
import { useLoad } from "./useLoad";
import { Scopes } from "./components/Scopes";
import { EpisodeList, MemoryList, SearchResults, TraitList } from "./components/Lists";
import { Detail } from "./components/Detail";
import { Dialog } from "./components/Dialog";
import { Consolidate } from "./components/Consolidate";

// three.js pesa más que todo lo demás junto: se baja sólo al abrir el grafo.
const GraphView = lazy(() => import("./components/GraphView"));

export type View = "memories" | "traits" | "pending" | "graph";

export type Selection =
  | { layer: "memory"; id: string }
  | { layer: "trait"; id: string }
  | { layer: "episode"; id: string; episode: EpisodeItem };

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "memories", label: "Memorias" },
  { id: "traits", label: "Rasgos" },
  { id: "pending", label: "Sin consolidar" },
  { id: "graph", label: "Grafo" },
];

const POLARITIES: Array<{ id: Polarity; label: string }> = [
  { id: "neutral", label: "Neutra: un patrón, sin juicio" },
  { id: "light", label: "Luz: algo que conviene repetir" },
  { id: "shadow", label: "Sombra: algo que conviene evitar" },
];

export function App() {
  const [scope, setScope] = useState<string | undefined>();
  const [view, setView] = useState<View>("memories");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  // Sube con cada escritura: las listas, los ámbitos y el detalle vuelven a cargar.
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<Map<string, string> | null>(null);
  const [crystallizing, setCrystallizing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const scopes = useLoad(() => api.scopes(), [version]);

  // Escape cierra el detalle (en el móvil ocupa toda la pantalla), salvo que lo esté usando
  // un diálogo abierto, que se cierra solo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const changed = (next?: Selection | null) => {
    setVersion((v) => v + 1);
    if (next !== undefined) setSelected(next);
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draft.trim());
  };

  const togglePick = (id: string, memoryScope: string) =>
    setPicked((prev) => {
      const next = new Map(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.set(id, memoryScope);
      return next;
    });

  const pickedScopes = new Set(picked?.values() ?? []);
  const pickedScope = pickedScopes.size === 1 ? [...pickedScopes][0] : undefined;

  return (
    <div className="app" data-detail={selected ? "open" : "closed"}>
      <header className="bar">
        <a className="brand" href="./" aria-label="misMEM, inicio">
          mis<span>MEM</span>
        </a>
        <form className="search" role="search" onSubmit={search}>
          <input
            type="search"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (!e.target.value) setQuery("");
            }}
            placeholder="Buscar en la memoria"
            aria-label="Buscar en la memoria"
          />
        </form>
        <button className="button bar-action" onClick={() => setConsolidating(true)}>
          Consolidar ahora
        </button>
      </header>

      <nav className="scopes" aria-label="Ámbitos">
        <Scopes state={scopes} current={scope} onChange={setScope} />
      </nav>

      <main className="list" data-view={query ? "search" : view}>
        {query ? (
          <SearchResults query={query} scope={scope} version={version} selected={selected} onSelect={setSelected} />
        ) : (
          <>
            <div className="tabs">
              <div role="tablist" aria-label="Capa" className="tablist">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={view === v.id}
                    className="tab"
                    data-layer={v.id}
                    onClick={() => {
                      setView(v.id);
                      setPicked(null);
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {view === "memories" && (
                <button
                  className="tab-action"
                  aria-pressed={picked !== null}
                  onClick={() => setPicked(picked ? null : new Map())}
                >
                  {picked ? "Terminar selección" : "Seleccionar"}
                </button>
              )}
            </div>
            {view === "memories" && (
              <MemoryList
                scope={scope}
                version={version}
                selected={selected}
                onSelect={setSelected}
                picked={picked ?? undefined}
                onPick={picked ? togglePick : undefined}
              />
            )}
            {view === "traits" && <TraitList scope={scope} version={version} selected={selected} onSelect={setSelected} />}
            {view === "pending" && (
              <EpisodeList scope={scope} version={version} selected={selected} onSelect={setSelected} />
            )}
            {view === "graph" && (
              <Suspense fallback={<p className="note">Cargando el grafo…</p>}>
                <GraphView key={version} scope={scope} onSelect={setSelected} />
              </Suspense>
            )}
          </>
        )}
        {picked && picked.size > 0 && (
          <div className="pick-bar" role="status">
            <span>
              {picked.size === 1 ? "1 memoria seleccionada" : `${picked.size} memorias seleccionadas`}
              {pickedScopes.size > 1 && ", de ámbitos distintos: un rasgo sólo junta memorias de uno"}
            </span>
            <button className="button primary" disabled={!pickedScope} onClick={() => setCrystallizing(true)}>
              Cristalizar como rasgo
            </button>
          </div>
        )}
      </main>

      <aside className="detail" aria-label="Detalle">
        {selected ? (
          <Detail
            selection={selected}
            version={version}
            onSelect={setSelected}
            onClose={() => setSelected(null)}
            onChanged={changed}
          />
        ) : (
          <p className="detail-empty">Elige un recuerdo para ver de dónde sale y qué lo cita.</p>
        )}
      </aside>

      {consolidating && (
        <Consolidate scope={scope} onClose={() => setConsolidating(false)} onFinished={refresh} />
      )}

      {crystallizing && picked && pickedScope && (
        <CrystallizeDialog
          scope={pickedScope}
          ids={[...picked.keys()]}
          onClose={() => setCrystallizing(false)}
          onDone={(traitId) => {
            setPicked(null);
            changed({ layer: "trait", id: traitId });
          }}
        />
      )}
    </div>
  );
}

function CrystallizeDialog({
  scope,
  ids,
  onClose,
  onDone,
}: {
  scope: string;
  ids: string[];
  onClose: () => void;
  onDone: (traitId: string) => void;
}) {
  const [name, setName] = useState("");
  const [polarity, setPolarity] = useState<Polarity>("neutral");
  return (
    <Dialog
      title="Cristalizar como rasgo"
      action="Cristalizar"
      onClose={onClose}
      onConfirm={async () => {
        if (!name.trim()) throw new Error("el rasgo necesita un nombre");
        const out = await actions.crystallize(scope, name.trim(), polarity, ids);
        onDone(out.trait_id);
      }}
    >
      <p>
        Un rasgo es un patrón estable que las {ids.length} memorias sostienen en <strong>{scope}</strong>. Si ya existe
        uno con el mismo nombre, gana fuerza en vez de duplicarse.
      </p>
      <label className="field">
        <span>Nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Prefiere soluciones sin dependencias" />
      </label>
      <fieldset className="field">
        <legend>Polaridad</legend>
        {POLARITIES.map((p) => (
          <label key={p.id} className="radio">
            <input
              type="radio"
              name="polarity"
              value={p.id}
              checked={polarity === p.id}
              onChange={() => setPolarity(p.id)}
            />
            {p.label}
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
