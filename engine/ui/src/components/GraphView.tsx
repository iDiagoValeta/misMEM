import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { forceX, forceY, type ForceLink, type ForceManyBody } from "d3-force";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { api, type GraphLink, type GraphNode, type Layer } from "../api";
import { errorMessage } from "../lib/errors";
import { escapeHtml, filterGraph, neighborsOf, scopePalette, type GraphFilters } from "../lib/graph";
import { DEFAULT_SETTINGS, GraphPanel, type GraphSettings } from "./GraphPanel";
import { colorOfLink, colorOfNode, nodeWeight, paintNode, type Link, type Node, widthOfLink } from "./graph/paint";

interface Props {
  scope: string | undefined;
  query: string;
  selectedId?: string;
  /** La pestaña está a la vista: si no, se pausa la animación aunque el grafo siga montado. */
  active: boolean;
  onSelect: (layer: Layer, id: string) => void;
}

const EMPTY = { nodes: [] as GraphNode[], links: [] as GraphLink[], truncated: { memories: false, traits: false, episodes: false } };

export default function GraphView({ scope, query, selectedId, active: visible, onSelect }: Props) {
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_SETTINGS);
  const [hovered, setHovered] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const fitted = useRef(false);
  const positions = useRef(new Map<string, { x: number; y: number }>());

  // Al cambiar de ámbito no se enseña el grafo del anterior: sólo se conserva mientras
  // se recarga el mismo ámbito (por ejemplo, al encender los episodios).
  const graphQuery = useQuery({
    queryKey: ["graph", scope ?? "", settings.episodes],
    queryFn: ({ signal }) => api.graph(scope, settings.episodes, signal),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (scope ?? "") ? previous : undefined,
  });
  const data = graphQuery.data;

  // El centro del grafo local sólo importa si el modo está encendido: así seleccionar
  // con el modo apagado no reconstruye los datos ni despierta la simulación.
  const centerId = settings.localEnabled ? selectedId : undefined;

  const filters = useMemo<GraphFilters>(
    () => ({
      traits: settings.traits,
      orphans: settings.orphans,
      related: settings.related,
      episodes: settings.episodes,
      query,
      local: { enabled: settings.localEnabled, depth: settings.depth, centerId },
    }),
    [
      settings.traits,
      settings.orphans,
      settings.related,
      settings.episodes,
      settings.localEnabled,
      settings.depth,
      query,
      centerId,
    ],
  );

  const graphData = useMemo(() => {
    const filtered = data ? filterGraph(data, filters) : EMPTY;
    // force-graph recibe copias y las coloca desde cero: se les devuelve su último sitio
    // para que filtrar o seleccionar no reinicie el dibujo bajo una cámara que no se mueve.
    for (const node of filtered.nodes) {
      const saved = positions.current.get(node.id);
      if (saved) {
        const placed = node as GraphNode & { x?: number; y?: number };
        placed.x = saved.x;
        placed.y = saved.y;
      }
    }
    return filtered;
  }, [data, filters]);

  const scopes = useMemo(() => data?.nodes.map((node) => node.scope) ?? [], [data]);
  const palette = useMemo(() => scopePalette(scopes), [scopes]);

  // Un episodio no tiene detalle propio: abre la memoria en la que se consolidó.
  const origins = useMemo(() => {
    const map = new Map<string, string>();
    for (const link of data?.links ?? []) if (link.kind === "origin") map.set(link.source, link.target);
    return map;
  }, [data]);

  const active = hovered ?? selectedId ?? null;
  const neighbors = useMemo(
    () => (active ? neighborsOf(graphData.links, active) : new Set<string>()),
    [active, graphData.links],
  );
  const isLit = useCallback(
    (id: string) => active === null || id === active || neighbors.has(id),
    [active, neighbors],
  );

  const changeSettings = useCallback(
    (patch: Partial<GraphSettings>) => setSettings((previous) => ({ ...previous, ...patch })),
    [],
  );

  const nodeVal = useCallback((node: Node) => nodeWeight(node) * settings.nodeSize, [settings.nodeSize]);

  const nodeColor = useCallback(
    (node: Node) => colorOfNode(node, palette, settings.colorByScope),
    [palette, settings.colorByScope],
  );

  const nodeCanvasObject = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, scale: number) =>
      paintNode(node, ctx, scale, {
        nodeSize: settings.nodeSize,
        textThreshold: settings.textThreshold,
        selectedId,
        active,
        isLit,
        color: nodeColor,
        positions: positions.current,
      }),
    [active, isLit, nodeColor, selectedId, settings.nodeSize, settings.textThreshold],
  );

  const linkColor = useCallback((link: Link) => colorOfLink(link, active), [active]);

  const linkWidth = useCallback((link: Link) => widthOfLink(link, active), [active]);

  const onNodeHover = useCallback((node: Node | null) => setHovered(node ? String(node.id) : null), []);

  const onNodeClick = useCallback(
    (node: Node) => {
      const id = String(node.id);
      if (node.layer === "episode") {
        const memory = origins.get(id);
        if (memory) onSelect("memory", memory);
        return;
      }
      onSelect(node.layer, id);
    },
    [onSelect, origins],
  );

  const onEngineStop = useCallback(() => {
    if (fitted.current || graphData.nodes.length === 0) return;
    fitted.current = true;
    graphRef.current?.zoomToFit(500, 40);
  }, [graphData.nodes.length]);

  // Fuerzas de la maqueta: gravedad al centro, repulsión, enlace y distancia ajustables.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const charge = graph.d3Force("charge") as ForceManyBody<Node> | undefined;
    charge?.strength(-settings.repulsion);
    const link = graph.d3Force("link") as ForceLink<Node, GraphLink> | undefined;
    link?.distance(settings.distance).strength((edge) => settings.link * (edge.kind === "related" ? 0.5 : 1));
    graph.d3Force("x", forceX<Node>(0).strength(settings.center));
    graph.d3Force("y", forceY<Node>(0).strength(settings.center));
    graph.d3ReheatSimulation();
  }, [settings.center, settings.repulsion, settings.link, settings.distance, size.width]);

  // El tamaño lo pone el contenedor, no la ventana: el grafo vive dentro de una pestaña.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      // La pestaña inactiva se oculta con display:none y mediría cero: aceptarlo
      // desmontaría el canvas y se perderían cámara y simulación al volver.
      if (width === 0 || height === 0) return;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Oculto sigue montado, pero no debe gastar CPU: se pausa la animación y se reanuda
  // al volver, sin reiniciar ni la simulación ni la cámara. `size.width` reaplica el
  // estado cuando el canvas termina de montarse después del primer efecto.
  useEffect(() => {
    if (visible) graphRef.current?.resumeAnimation();
    else graphRef.current?.pauseAnimation();
  }, [visible, size.width]);

  // force-graph muta los nodos y les añade x/y; este ref da acceso a esas coordenadas.
  const positioned = graphData.nodes as Array<GraphNode & { x?: number; y?: number }>;
  const nodesRef = useRef(positioned);
  nodesRef.current = positioned;

  // Seleccionar desde fuera (lista o detalle) lleva la cámara al nodo, sin tocar el zoom.
  useEffect(() => {
    if (!selectedId) return;
    let attempts = 0;
    let timer = 0;
    const focus = () => {
      const node = nodesRef.current.find((entry) => entry.id === selectedId);
      if (node?.x != null && node.y != null) {
        graphRef.current?.centerAt(node.x, node.y, 600);
        return;
      }
      if (attempts++ < 20) timer = window.setTimeout(focus, 100);
    };
    focus();
    return () => window.clearTimeout(timer);
  }, [selectedId, size.width]);

  const truncated: string[] = [];
  if (data?.truncated.memories) truncated.push("memorias");
  if (data?.truncated.traits) truncated.push("rasgos");
  if (data?.truncated.episodes) truncated.push("episodios");

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[360px] w-full overflow-hidden rounded-lg border border-edge bg-surface"
    >
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          nodeId="id"
          backgroundColor="rgba(0,0,0,0)"
          autoPauseRedraw={false}
          cooldownTicks={200}
          nodeVal={nodeVal}
          nodeColor={nodeColor}
          nodeLabel={(node) => escapeHtml(node.label)}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={(node, color, ctx) => {
            if (node.x == null || node.y == null) return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 7, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={(link) => (link.kind === "related" ? [2, 2] : null)}
          // En la punta de la arista; longitud 0 deja la línea limpia cuando están apagadas.
          linkDirectionalArrowLength={settings.arrows ? 3 : 0}
          linkDirectionalArrowRelPos={1}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          onEngineStop={onEngineStop}
        />
      )}

      <GraphPanel settings={settings} onChange={changeSettings} scopes={scopes} width={size.width} />

      {data === undefined && graphQuery.isPending && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="text-sm text-ink-muted">Cargando el grafo…</p>
        </div>
      )}

      {data !== undefined && graphData.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <p className="max-w-sm text-center text-sm text-ink-muted">
            {data.nodes.length === 0
              ? "Este ámbito no tiene nada que dibujar todavía: ni memorias, ni rasgos, ni episodios."
              : "Ningún nodo pasa los filtros. Enciende una capa o borra la búsqueda."}
          </p>
        </div>
      )}

      {truncated.length > 0 && (
        <p className="absolute right-3 bottom-3 left-3 rounded-md border border-edge bg-surface-raised/95 px-3 py-1.5 text-xs text-ink-muted sm:left-auto sm:max-w-sm">
          Recortado por el servidor en {truncated.join(", ")}: se dibujan las filas con más saliencia.
        </p>
      )}

      {graphQuery.isError && (
        <p
          role="alert"
          className="absolute right-3 bottom-3 left-3 rounded-md border border-edge bg-surface-raised/95 px-3 py-1.5 text-xs text-danger sm:left-auto sm:max-w-sm"
        >
          No se pudo cargar el grafo: {errorMessage(graphQuery.error)}
        </p>
      )}
    </div>
  );
}
