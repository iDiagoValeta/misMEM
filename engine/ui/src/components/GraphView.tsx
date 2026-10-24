import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import { Mesh, MeshLambertMaterial, OctahedronGeometry, type Object3D } from "three";
import { api, type GraphData, type GraphNode } from "../api";
import type { Selection } from "../App";
import { useLoad } from "../useLoad";

interface Props {
  scope: string | undefined;
  onSelect: (selection: Selection) => void;
}

/**
 * Lee un color del tema. three.js no entiende oklch, así que se pinta en un píxel y se
 * lee de vuelta: el grafo queda con los mismos colores que la lista, en claro y oscuro.
 */
function themeColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#888888";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

interface Palette {
  memory: string;
  trait: string;
  episode: string;
  related: string;
  background: string;
}

function readPalette(): Palette {
  return {
    memory: themeColor("--memory"),
    trait: themeColor("--trait"),
    episode: themeColor("--episode"),
    related: themeColor("--ink-faint"),
    background: themeColor("--paper"),
  };
}

/** El tooltip de la librería es HTML: el texto de un recuerdo tiene que ir escapado. */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

type Node = GraphNode & { x?: number; y?: number; z?: number };

export default function GraphView({ scope, onSelect }: Props) {
  const [episodes, setEpisodes] = useState(false);
  const state = useLoad<GraphData>(() => api.graph(scope, episodes), [scope, episodes]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState<Palette>(readPalette);

  // El lienzo de WebGL no se adapta solo: se le pasa el tamaño de su caja.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setPalette(readPalette());
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Las aristas guardan ids; la librería las reemplaza por los nodos al simular, así que
  // se le da una copia para no tocar lo que devolvió la API.
  const data = useMemo(
    () =>
      state.data
        ? { nodes: state.data.nodes.map((n) => ({ ...n })), links: state.data.links.map((l) => ({ ...l })) }
        : { nodes: [], links: [] },
    [state.data],
  );
  const originOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of state.data?.links ?? []) if (l.kind === "origin") map.set(l.source, l.target);
    return map;
  }, [state.data]);

  const crystal = useMemo(() => {
    const geometry = new OctahedronGeometry(5);
    const material = new MeshLambertMaterial({ color: palette.trait, transparent: true, opacity: 0.9 });
    return () => new Mesh(geometry, material);
  }, [palette.trait]);

  const select = (node: Node) => {
    if (node.layer === "trait") onSelect({ layer: "trait", id: node.id });
    else if (node.layer === "memory") onSelect({ layer: "memory", id: node.id });
    else {
      // Un episodio consolidado se entiende mejor desde su memoria, que lo muestra en su origen.
      const memory = originOf.get(node.id);
      if (memory) onSelect({ layer: "memory", id: memory });
    }
  };

  const counts = state.data?.nodes.reduce(
    (acc, n) => ({ ...acc, [n.layer]: (acc[n.layer] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const related = state.data?.links.filter((l) => l.kind === "related").length ?? 0;

  return (
    <div className="graph">
      <div className="graph-bar">
        <span className="legend" data-layer="memory">
          Memorias {counts?.memory ?? 0}
        </span>
        <span className="legend" data-layer="trait">
          Rasgos {counts?.trait ?? 0}
        </span>
        <label className="legend" data-layer="episode">
          <input type="checkbox" checked={episodes} onChange={(e) => setEpisodes(e.target.checked)} />
          Episodios {episodes ? (counts?.episode ?? 0) : ""}
        </label>
        <span className="graph-hint">{related} parecidos. Arrastra para girar, rueda para acercar.</span>
      </div>
      <div className="graph-canvas" ref={box}>
        {state.error && <p className="note">No se pudo cargar el grafo: {state.error}</p>}
        {!state.data && !state.error && (
          <p className="note" aria-busy="true">
            Cargando…
          </p>
        )}
        {state.data && size.width > 0 && (
          <ForceGraph3D
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor={palette.background}
            showNavInfo={false}
            nodeId="id"
            nodeLabel={(n: object) => escapeHtml((n as Node).label)}
            nodeVal={(n: object) => {
              const node = n as Node;
              if (node.layer === "trait") return 6;
              if (node.layer === "episode") return 0.5;
              return 1 + 5 * (node.salience ?? 0.5);
            }}
            nodeColor={(n: object) => palette[(n as Node).layer]}
            nodeOpacity={0.92}
            // Sin objeto propio la librería dibuja su esfera; los tipos no admiten ese vacío.
            nodeThreeObject={(n: object) =>
              ((n as Node).layer === "trait" ? crystal() : undefined) as unknown as Object3D
            }
            linkColor={(l: object) => {
              const kind = (l as { kind: string }).kind;
              return kind === "evidence" ? palette.trait : kind === "origin" ? palette.episode : palette.related;
            }}
            linkOpacity={0.45}
            linkWidth={(l: object) => ((l as { kind: string }).kind === "evidence" ? 1.2 : 0)}
            onNodeClick={(n: object) => select(n as Node)}
            enableNodeDrag={false}
            cooldownTicks={120}
          />
        )}
      </div>
    </div>
  );
}
