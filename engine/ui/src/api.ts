/** Lo que devuelve la API del viewer (engine/src/viewer.ts y viewer-api.ts). */

export type Layer = "episode" | "memory" | "trait";

export interface ScopeCount {
  scope: string;
  episodes_pending: number;
  episodes_consolidated: number;
  memories: number;
  traits: number;
}

export interface MemoryItem {
  id: string;
  scope: string;
  text: string;
  details: string | null;
  salience: number;
  stored_salience: number;
  created_at: number;
  last_accessed_at: number | null;
  noise: boolean;
  sources?: number;
  episodes_left?: number;
  traits?: number;
}

export interface TraitItem {
  id: string;
  scope: string;
  text: string;
  strength: number;
  polarity: string;
  created_at: number;
  updated_at: number;
}

export interface EpisodeItem {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  consolidated_into?: string | null;
  linked_here?: boolean;
}

export interface Missing {
  id: string;
  missing: true;
}

export interface SearchHit {
  layer: Layer;
  id: string;
  scope: string;
  text: string;
  salience?: number;
  created_at: number;
  via?: "semantic";
}

export interface MemoryDetail {
  memory: MemoryItem;
  episodes: Array<EpisodeItem | Missing>;
  traits: TraitItem[];
}

export interface TraitDetail {
  trait: TraitItem;
  evidence: Array<MemoryItem | Missing>;
}

export interface GraphNode {
  id: string;
  layer: Layer;
  scope: string;
  label: string;
  salience?: number;
  strength?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: "origin" | "evidence" | "related";
  score?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  truncated: { memories: boolean };
}

export const isMissing = (item: object): item is Missing => "missing" in item;

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const qs = query.toString();
  // Relativo a /viewer/: funciona igual detrás de un proxy que monte misMEM en otra ruta.
  const res = await fetch(`../api/${path}${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  stats: () =>
    get<{ counts: { episodes: number; memories: number; traits: number; consolidated: number } }>("stats"),
  scopes: () => get<{ scopes: ScopeCount[] }>("scopes"),
  memories: (scope?: string) => get<{ total: number; memories: MemoryItem[] }>("memories", { scope, limit: "200" }),
  traits: (scope?: string) =>
    get<{ rows: TraitItem[] }>("recent", { layer: "trait", scope, limit: "200" }),
  episodes: (scope?: string) =>
    get<{ rows: EpisodeItem[] }>("recent", { layer: "episode", scope, limit: "200" }),
  search: (q: string, scope?: string) => get<{ hits: SearchHit[] }>("search", { q, scope, limit: "40" }),
  graph: (scope: string | undefined, episodes: boolean) =>
    get<GraphData>("graph", { scope, related: "1", episodes: episodes ? "1" : undefined }),
  memory: (id: string) => get<MemoryDetail>(`memory/${encodeURIComponent(id)}`),
  trait: (id: string) => get<TraitDetail>(`trait/${encodeURIComponent(id)}`),
};
