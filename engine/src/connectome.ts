/**
 * El conectoma: la capa lateral de la memoria.
 *
 * `origin` y `evidence` son aristas verticales —de dónde salió cada cosa— y van
 * siempre hacia arriba: episodio → memoria → rasgo. El co-uso es la única arista
 * horizontal que hay: memoria ↔ memoria, y dice qué se usa junto con qué.
 *
 * El peso NO es el conteo crudo. Un recuerdo que se usa en todos los turnos
 * co-ocurre con todo, así que por conteo sería el centro del grafo sin orientar a
 * nada: es el mismo error de la saliencia midiendo recencia. Lo que se usa acá es
 * NPMI (información mutua puntual normalizada), que pregunta si el par aparece
 * junto *más de lo esperable por azar*:
 *
 *   -1  se evitan     0  indistinguible del azar     1  nunca aparecen separados
 *
 * Con pocos datos es ruidoso por construcción: dos recuerdos usados una sola vez,
 * esa vez juntos, dan 1. Por eso las aristas viajan con su `n` y quien consume
 * decide el soporte mínimo; acá no se esconde nada.
 */
import type { Database as DB } from "better-sqlite3";

const TURNS_KEY = "connectome.turns";

export interface CoUseEdge {
  memory_a: string;
  memory_b: string;
  /** Turnos en que el par se usó junto. Es el soporte: sin él la fuerza no se interpreta. */
  n: number;
  /** NPMI en [-1, 1]. */
  strength: number;
  last_at: number;
}

export interface Hub {
  id: string;
  /** Vecinos por encima del soporte, sin pesar: cuenta de popularidad. */
  degree: number;
  /** Suma de las asociaciones positivas. Es esto lo que ordena, no el grado. */
  strength: number;
}

export interface EdgeQuery {
  /** Acota a este conjunto: una arista hacia un nodo que no se dibuja queda colgada. */
  ids?: readonly string[];
  /** Soporte mínimo, en turnos. Por defecto 1: devuelve todo y deja decidir afuera. */
  minN?: number;
}

/**
 * Turnos de uso medido registrados. Es el denominador: sin él no se puede saber
 * si un par aparece junto más de lo esperable.
 */
export function turnsRegistered(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(TURNS_KEY) as
    | { value: string }
    | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Suma un turno. La llama `reinforce`, nunca el camino de recall. */
export function registerTurn(db: DB): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run(TURNS_KEY);
}

/**
 * NPMI del par. Devuelve 0 —"no sé"— y no un número inventado cuando falta el
 * denominador o alguno de los dos no registra uso.
 */
export function associationStrength(args: {
  n: number;
  useA: number;
  useB: number;
  turns: number;
}): number {
  const { n, useA, useB, turns } = args;
  if (turns <= 0 || n <= 0 || useA <= 0 || useB <= 0) return 0;

  const pab = Math.min(n / turns, 1);
  const pa = Math.min(useA / turns, 1);
  const pb = Math.min(useB / turns, 1);
  // Juntos en todos los turnos: el denominador se anula y el límite es 1.
  if (pab >= 1) return 1;

  const npmi = Math.log(pab / (pa * pb)) / -Math.log(pab);
  if (!Number.isFinite(npmi)) return 0;
  return Math.max(-1, Math.min(1, npmi));
}

interface RawEdge {
  memory_a: string;
  memory_b: string;
  n: number;
  last_at: number;
  use_a: number;
  use_b: number;
}

function rawEdges(db: DB, query: EdgeQuery): RawEdge[] {
  const minN = Math.max(1, query.minN ?? 1);
  const scoped = query.ids !== undefined;
  const rows = db
    .prepare(
      `SELECT c.memory_a, c.memory_b, c.n, c.last_at, a.use_count AS use_a, b.use_count AS use_b
       FROM co_use c
       JOIN memories a ON a.id = c.memory_a
       JOIN memories b ON b.id = c.memory_b
       WHERE c.n >= @minN
         AND (@scoped = 0 OR (
           c.memory_a IN (SELECT value FROM json_each(@ids))
           AND c.memory_b IN (SELECT value FROM json_each(@ids))
         ))`,
    )
    .all({
      minN,
      scoped: scoped ? 1 : 0,
      ids: JSON.stringify(scoped ? [...new Set(query.ids)] : []),
    }) as RawEdge[];
  return rows;
}

/** Aristas laterales, de la más asociada a la menos. */
export function coUseEdges(db: DB, query: EdgeQuery = {}): CoUseEdge[] {
  const turns = turnsRegistered(db);
  return rawEdges(db, query)
    .map((r) => ({
      memory_a: r.memory_a,
      memory_b: r.memory_b,
      n: r.n,
      last_at: r.last_at,
      strength: associationStrength({ n: r.n, useA: r.use_a, useB: r.use_b, turns }),
    }))
    .sort((x, y) => y.strength - x.strength || y.n - x.n);
}

/**
 * Los nodos por los que conviene entrar. Ordena por asociación acumulada y no por
 * grado, que es la diferencia entre un hub y el recuerdo más popular.
 */
export function hubs(db: DB, query: EdgeQuery = {}): Hub[] {
  const acc = new Map<string, Hub>();
  const bump = (id: string, strength: number): void => {
    const cur = acc.get(id) ?? { id, degree: 0, strength: 0 };
    cur.degree += 1;
    if (strength > 0) cur.strength += strength;
    acc.set(id, cur);
  };

  for (const edge of coUseEdges(db, query)) {
    bump(edge.memory_a, edge.strength);
    bump(edge.memory_b, edge.strength);
  }

  return [...acc.values()].sort((x, y) => y.strength - x.strength || y.degree - x.degree);
}
