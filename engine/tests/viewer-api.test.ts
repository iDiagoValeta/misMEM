import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, crystallize, reinforce } from "../src/tools.js";
import {
  handleGraph,
  handleMemories,
  handleMemory,
  handleScopes,
  handleTrait,
  parseDetailPath,
} from "../src/viewer-api.js";

const DAY = 86_400_000;
let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload ?? "";
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(fn: (res: any) => void): { status: number; body: any } {
  const res = mockRes();
  fn(res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const url = (path: string): URL => new URL(`http://x${path}`);

function memoryFrom(scope: string, gist: string, bodies: string[]): { memoryId: string; episodeIds: string[] } {
  const episodeIds = bodies.map((body) => capture(db, { scope, body }).id);
  const { memory_id } = consolidate(db, { scope, gist, source_episode_ids: episodeIds });
  return { memoryId: memory_id, episodeIds };
}

describe("viewer-api: parseDetailPath", () => {
  it("devuelve capa e id en una ruta de detalle y decodifica el id", () => {
    expect(parseDetailPath("/api/memory/abc")).toEqual({ layer: "memory", id: "abc" });
    expect(parseDetailPath("/api/memory/a%20b")).toEqual({ layer: "memory", id: "a b" });
    expect(parseDetailPath("/api/trait/x")).toEqual({ layer: "trait", id: "x" });
  });

  it("un id mal codificado es un error del cliente, no del servidor", () => {
    expect(parseDetailPath("/api/memory/%")).toBe("bad");
    expect(parseDetailPath("/api/memory/%C3")).toBe("bad");
  });

  it("cualquier otra ruta no es de detalle", () => {
    expect(parseDetailPath("/api/memory/")).toBeNull();
    expect(parseDetailPath("/api/memory/a/b")).toBeNull();
  });
});

describe("viewer-api: /api/scopes", () => {
  it("cuenta por capa y ámbito, sin marcadores de ruido entre las memorias", () => {
    memoryFrom("a", "una memoria", ["ep1", "ep2"]);
    memoryFrom("a", "[noise] 1 episodio sin citar", ["ep3"]);
    capture(db, { scope: "b", body: "pendiente" });
    const { memoryId } = memoryFrom("b", "otra", ["ep4"]);
    crystallize(db, { scope: "b", name: "un rasgo", evidence_memory_ids: [memoryId] });

    const { body } = call((res) => handleScopes(db, res));
    expect(body.scopes).toEqual([
      { scope: "a", episodes_pending: 0, episodes_consolidated: 3, memories: 1, traits: 0 },
      { scope: "b", episodes_pending: 1, episodes_consolidated: 1, memories: 1, traits: 1 },
    ]);
  });
});

describe("viewer-api: /api/memories", () => {
  it("ordena por la salience de hoy, no por la guardada", () => {
    const old = memoryFrom("a", "vieja y olvidada", ["e1"]).memoryId;
    const fresh = memoryFrom("a", "de ayer", ["e2"]).memoryId;
    const now = Date.now();
    db.prepare("UPDATE memories SET salience = 1.0, salience_updated_at = ? WHERE id = ?").run(now - 365 * DAY, old);
    db.prepare("UPDATE memories SET salience = 0.9, salience_updated_at = ? WHERE id = ?").run(now - DAY, fresh);

    const { body } = call((res) => handleMemories(db, res, url("/api/memories"), now));
    expect(body.memories.map((m: { id: string }) => m.id)).toEqual([fresh, old]);
    expect(body.memories[1].stored_salience).toBe(1);
    expect(body.memories[1].salience).toBeLessThan(0.1);
  });

  it("cuenta fuentes, episodios que quedan y rasgos que la citan", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "con fuentes", ["e1", "e2"]);
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const { body } = call((res) => handleMemories(db, res, url("/api/memories")));
    expect(body.memories[0]).toMatchObject({ id: memoryId, sources: 2, episodes_left: 1, traits: 1, noise: false });
  });

  it("filtra por ámbito, esconde el ruido salvo noise=1 y pagina", () => {
    memoryFrom("a", "a uno", ["e1"]);
    memoryFrom("a", "[pareto:l0] 2 episodios filtrados", ["e2"]);
    memoryFrom("b", "b uno", ["e3"]);

    expect(call((res) => handleMemories(db, res, url("/api/memories?scope=a"))).body.total).toBe(1);
    expect(call((res) => handleMemories(db, res, url("/api/memories?scope=a&noise=1"))).body.total).toBe(2);
    const page = call((res) => handleMemories(db, res, url("/api/memories?limit=1&offset=1"))).body;
    expect(page.total).toBe(2);
    expect(page.memories).toHaveLength(1);
  });
});

describe("viewer-api: /api/memory/:id", () => {
  it("devuelve la cadena de origen: episodios y rasgos que la citan", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "la memoria", ["primero", "segundo"]);
    const trait = crystallize(db, { scope: "a", name: "el rasgo", evidence_memory_ids: [memoryId] });

    const { status, body } = call((res) => handleMemory(db, res, memoryId));
    expect(status).toBe(200);
    expect(body.memory).toMatchObject({ id: memoryId, text: "la memoria" });
    expect(body.episodes.map((e: { id: string; text: string }) => [e.id, e.text])).toEqual([
      [episodeIds[0], "primero"],
      [episodeIds[1], "segundo"],
    ]);
    expect(body.traits.map((t: { id: string }) => t.id)).toEqual([trait.trait_id]);
  });

  it("un episodio que forget ya borró queda marcado, no desaparece", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "la memoria", ["primero", "segundo"]);
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);
    const { body } = call((res) => handleMemory(db, res, memoryId));
    expect(body.episodes[0]).toEqual({ id: episodeIds[0], missing: true });
    expect(body.episodes[1]).toMatchObject({ id: episodeIds[1], linked_here: true });
  });

  it("un id que no existe es 404", () => {
    expect(call((res) => handleMemory(db, res, "NOPE")).status).toBe(404);
  });
});

describe("viewer-api: /api/trait/:id", () => {
  it("devuelve las memorias que lo sostienen y marca las que ya no existen", () => {
    const { memoryId } = memoryFrom("a", "evidencia", ["e1"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId, "BORRADA"] });

    const { body } = call((res) => handleTrait(db, res, trait.trait_id));
    expect(body.trait).toMatchObject({ id: trait.trait_id, text: "rasgo", strength: 2 });
    expect(body.evidence[0]).toMatchObject({ id: memoryId, text: "evidencia" });
    expect(body.evidence[1]).toEqual({ id: "BORRADA", missing: true });
    expect(call((res) => handleTrait(db, res, "NOPE")).status).toBe(404);
  });
});

describe("viewer-api: /api/graph", () => {
  it("nodos y aristas de origen; los episodios sólo si se piden", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "memoria", ["e1"]);
    memoryFrom("a", "[noise] ruido", ["e2"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const plain = call((res) => handleGraph(db, res, url("/api/graph"))).body;
    expect(plain.nodes.map((n: { id: string; layer: string }) => [n.id, n.layer])).toEqual([
      [memoryId, "memory"],
      [trait.trait_id, "trait"],
    ]);
    expect(plain.links).toEqual([{ source: memoryId, target: trait.trait_id, kind: "evidence" }]);

    const full = call((res) => handleGraph(db, res, url("/api/graph?episodes=1"))).body;
    expect(full.links).toContainEqual({ source: episodeIds[0], target: memoryId, kind: "origin" });
    expect(full.nodes.some((n: { layer: string }) => n.layer === "episode")).toBe(true);
  });
});

describe("viewer-api: /api/graph?co_use=1 (la capa lateral)", () => {
  function parDeUso(): { a: string; b: string; suelta: string } {
    const a = memoryFrom("a", "el deploy usa docker compose", ["e1"]).memoryId;
    const b = memoryFrom("a", "el backup corre a las tres", ["e2"]).memoryId;
    const suelta = memoryFrom("a", "el bench corre con el embedder arriba", ["e3"]).memoryId;
    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [a, suelta] });
    return { a, b, suelta };
  }

  it("sin pedirla, la respuesta es la de siempre: ni aristas ni resumen de conectoma", () => {
    // Es el contrato que ya consume la interfaz: no puede cambiar por agregar esto.
    parDeUso();

    const body = call((res) => handleGraph(db, res, url("/api/graph"))).body;

    expect(body.links.some((l: { kind: string }) => l.kind === "co_use")).toBe(false);
    expect(body.connectome).toBeUndefined();
    expect(body.nodes.every((n: Record<string, unknown>) => n.co_use === undefined)).toBe(true);
  });

  it("pedida, trae las aristas laterales con su soporte y su fuerza", () => {
    const { a, b } = parDeUso();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const lateral = body.links.filter((l: { kind: string }) => l.kind === "co_use");

    expect(lateral).toHaveLength(2);
    const fuerte = lateral.find(
      (l: { source: string; target: string }) =>
        (l.source === a && l.target === b) || (l.source === b && l.target === a),
    );
    expect(fuerte).toMatchObject({ n: 2 });
    expect(typeof fuerte.strength).toBe("number");
  });

  it("las verticales siguen saliendo sin campos nuevos", () => {
    const { a } = parDeUso();
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [a] });

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;

    expect(body.links).toContainEqual({ source: a, target: trait.trait_id, kind: "evidence" });
  });

  it("el soporte mínimo saca los pares de una sola vez", () => {
    const { a, b } = parDeUso();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1&co_use_min_n=2"))).body;
    const lateral = body.links.filter((l: { kind: string }) => l.kind === "co_use");

    expect(lateral).toHaveLength(1);
    expect([lateral[0].source, lateral[0].target].sort()).toEqual([a, b].sort());
  });

  it("no deja aristas hacia nodos que no se dibujan", () => {
    const { a, b } = parDeUso();
    reinforce(db, { memory_ids: [a, memoryFrom("otro", "memoria de otro ámbito", ["e9"]).memoryId] });

    const body = call((res) => handleGraph(db, res, url("/api/graph?scope=a&co_use=1"))).body;
    const dibujados = new Set(body.nodes.map((n: { id: string }) => n.id));
    const lateral = body.links.filter((l: { kind: string }) => l.kind === "co_use");

    expect(lateral.length).toBeGreaterThan(0);
    for (const l of lateral) {
      expect(dibujados.has(l.source)).toBe(true);
      expect(dibujados.has(l.target)).toBe(true);
    }
    expect([a, b].every((id) => dibujados.has(id))).toBe(true);
  });

  it("los nodos traen con qué iluminarse: grado y asociación acumulada", () => {
    const { a } = parDeUso();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const nodo = body.nodes.find((n: { id: string }) => n.id === a);

    expect(nodo.co_use).toMatchObject({ degree: 2 });
    expect(typeof nodo.co_use.strength).toBe("number");
  });

  it("el resumen propone por dónde entrar, ordenado por asociación y no por vecinos", () => {
    // El que más vecinos tiene es el que se usa en todos los turnos: no orienta
    // a ninguno. Si los costados lo ponen primero, el panel miente.
    const siempre = memoryFrom("a", "hablamos en español y sin rodeos", ["e1"]).memoryId;
    const v1 = memoryFrom("a", "el deploy usa docker compose", ["e2"]).memoryId;
    const v2 = memoryFrom("a", "el backup corre a las tres", ["e3"]).memoryId;
    const par1 = memoryFrom("a", "el ordenador de memoria tiene tres fases", ["e4"]).memoryId;
    const par2 = memoryFrom("a", "la fase dos espera datos de co-uso", ["e5"]).memoryId;
    for (let i = 0; i < 3; i++) reinforce(db, { memory_ids: [siempre, v1, v2] });
    for (let i = 0; i < 9; i++) reinforce(db, { memory_ids: [siempre] });
    for (let i = 0; i < 3; i++) reinforce(db, { memory_ids: [par1, par2] });

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const ranking: Array<{ id: string; degree: number; strength: number }> = body.connectome.hubs;

    const puesto = (id: string): number => ranking.findIndex((h) => h.id === id);
    const quien = (id: string) => ranking.find((h) => h.id === id)!;

    // Lo que importa es el ORDEN: `siempre` tiene más vecinos que `par1`, así que
    // por grado iría antes. Tiene que ir después.
    expect(quien(siempre).degree).toBeGreaterThan(quien(par1).degree);
    expect(puesto(par1)).toBeLessThan(puesto(siempre));
    expect(ranking.map((h) => h.strength)).toEqual([...ranking.map((h) => h.strength)].sort((a, b) => b - a));
  });

  it("el resumen dice de qué tamaño es la muestra, para no mentir en los costados", () => {
    // Con pocos turnos la fuerza es ruido: el panel tiene que poder decirlo.
    parDeUso();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1&co_use_min_n=2"))).body;

    expect(body.connectome).toMatchObject({ turns: 3, pairs: 2, shown: 1, min_n: 2 });
  });
});
