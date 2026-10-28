import type { GraphData } from "../api";

/**
 * Lo que el panel deja tocar. `episodes` no sólo oculta la capa: también decide si se
 * pide al servidor, que es el único que sabe qué episodios siguen pendientes.
 */
export interface GraphFilters {
  traits: boolean;
  orphans: boolean;
  related: boolean;
  episodes: boolean;
  query: string;
  local: { enabled: boolean; depth: 1 | 2 | 3; centerId?: string };
}

/** Una arista en dos momentos: recién llegada de la API y ya mutada por force-graph. */
type LinkEnd = string | { id: string };

const idOf = (end: LinkEnd): string => (typeof end === "string" ? end : end.id);

/** Vecinos directos, sin importar si la librería ya sustituyó los ids por objetos nodo. */
export function neighborsOf(links: Array<{ source: LinkEnd; target: LinkEnd }>, id: string): Set<string> {
  const neighbors = new Set<string>();
  for (const link of links) {
    const source = idOf(link.source);
    const target = idOf(link.target);
    if (source === id) neighbors.add(target);
    else if (target === id) neighbors.add(source);
  }
  return neighbors;
}

/** El tooltip de la librería se inyecta como HTML: la etiqueta nunca puede traer marcado. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * Doce tonos medios, uno por ámbito, elegidos para pasar 3:1 (contraste de objeto gráfico)
 * contra las cuatro superficies de los dos temas: #1a1917, #21201d, #cbc9c3 y #d6d3cc.
 * Un tono más claro desaparece en claro; uno más oscuro, en oscuro.
 */
const SCOPE_COLORS = [
  "#d42300",
  "#946300",
  "#707030",
  "#447a0e",
  "#2f7c2f",
  "#127d47",
  "#157979",
  "#1c74a0",
  "#405df0",
  "#7860a9",
  "#a73ebb",
  "#b63d8d",
];

/** Reparte los doce colores entre los ámbitos con más nodos; el resto se queda sin color. */
export function scopePalette(scopes: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SCOPE_COLORS.length);
  const palette = new Map<string, string>();
  for (const [index, [scope]] of ranked.entries()) {
    const color = SCOPE_COLORS[index];
    if (color) palette.set(scope, color);
  }
  return palette;
}

/**
 * Devuelve una copia lista para force-graph, que muta `source`/`target` y añade x/y a los
 * nodos. El orden importa: si se recortara al final, el grafo local recorrería aristas que
 * ya no existen y el filtro de huérfanas contaría enlaces invisibles.
 */
export function filterGraph(data: GraphData, filters: GraphFilters): GraphData {
  const query = filters.query.trim().toLowerCase();

  // 1. Capas apagadas.
  let nodes = data.nodes.filter((node) =>
    node.layer === "memory" || (node.layer === "trait" ? filters.traits : filters.episodes),
  );

  // 2. Consulta sobre etiqueta o ámbito, igual que la lista.
  if (query) {
    nodes = nodes.filter(
      (node) => node.label.toLowerCase().includes(query) || node.scope.toLowerCase().includes(query),
    );
  }
  let links = data.links.filter((link) => filters.related || link.kind !== "related");

  // Las aristas de un nodo que ya no está no cuentan para nada de lo que sigue.
  let alive = new Set(nodes.map((node) => node.id));
  links = links.filter((link) => alive.has(link.source) && alive.has(link.target));

  // 3. Grafo local: sólo si el centro sigue visible. Si la consulta lo quitó, no se
  //    devuelve un grafo vacío: se ignora el modo local, como si estuviera apagado.
  const center = filters.local.centerId;
  if (filters.local.enabled && center && alive.has(center)) {
    const adjacency = new Map<string, string[]>();
    const connect = (from: string, to: string) => {
      const list = adjacency.get(from);
      if (list) list.push(to);
      else adjacency.set(from, [to]);
    };
    for (const link of links) {
      connect(link.source, link.target);
      connect(link.target, link.source);
    }

    const keep = new Set([center]);
    let frontier = [center];
    for (let step = 0; step < filters.local.depth; step++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (keep.has(neighbor)) continue;
          keep.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }

    nodes = nodes.filter((node) => keep.has(node.id));
    alive = new Set(keep);
    links = links.filter((link) => keep.has(link.source) && keep.has(link.target));
  }

  // 4. Sin huérfanas: un nodo que se quedó sin ninguna arista no aporta nada al dibujo.
  if (!filters.orphans) {
    const linked = new Set(links.flatMap((link) => [link.source, link.target]));
    nodes = nodes.filter((node) => linked.has(node.id));
  }

  // 5. Última pasada: ninguna arista puede apuntar a un nodo que ya no se pinta.
  const visible = new Set(nodes.map((node) => node.id));
  links = links.filter((link) => visible.has(link.source) && visible.has(link.target));

  return {
    nodes: nodes.map((node) => ({ ...node })),
    links: links.map((link) => ({ ...link })),
    truncated: { ...data.truncated },
  };
}
