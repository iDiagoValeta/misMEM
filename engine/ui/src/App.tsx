import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { api, type EpisodeItem } from "./api";
import { useLoad } from "./useLoad";
import { Scopes } from "./components/Scopes";
import { EpisodeList, MemoryList, SearchResults, TraitList } from "./components/Lists";
import { Detail } from "./components/Detail";

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

export function App() {
  const [scope, setScope] = useState<string | undefined>();
  const [view, setView] = useState<View>("memories");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const scopes = useLoad(() => api.scopes(), []);

  // Escape cierra el detalle: en el móvil ocupa toda la pantalla.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const search = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draft.trim());
  };

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
      </header>

      <nav className="scopes" aria-label="Ámbitos">
        <Scopes state={scopes} current={scope} onChange={setScope} />
      </nav>

      <main className="list" data-view={query ? "search" : view}>
        {query ? (
          <SearchResults query={query} scope={scope} selected={selected} onSelect={setSelected} />
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="Capa">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  aria-selected={view === v.id}
                  className="tab"
                  data-layer={v.id}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {view === "memories" && <MemoryList scope={scope} selected={selected} onSelect={setSelected} />}
            {view === "traits" && <TraitList scope={scope} selected={selected} onSelect={setSelected} />}
            {view === "pending" && <EpisodeList scope={scope} selected={selected} onSelect={setSelected} />}
            {view === "graph" && (
              <Suspense fallback={<p className="note">Cargando el grafo…</p>}>
                <GraphView scope={scope} onSelect={setSelected} />
              </Suspense>
            )}
          </>
        )}
      </main>

      <aside className="detail" aria-label="Detalle">
        {selected ? (
          <Detail selection={selected} onSelect={setSelected} onClose={() => setSelected(null)} />
        ) : (
          <p className="detail-empty">Elige un recuerdo para ver de dónde sale y qué lo cita.</p>
        )}
      </aside>
    </div>
  );
}
