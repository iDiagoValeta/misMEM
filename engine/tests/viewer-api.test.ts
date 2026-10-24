import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, crystallize } from "../src/tools.js";
import { saveMemoryEmbedding } from "../src/embeddings/index.js";
import {
  handleGraph,
  handleMemories,
  handleMemory,
  handleScopes,
  handleTrait,
  relatedLinks,
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

describe("viewer-api: aristas por parecido", () => {
  const vec = (...xs: number[]) => Float32Array.from(xs);
  function withVector(gist: string, v: Float32Array, model = "m"): string {
    const { memoryId } = memoryFrom("a", gist, [gist]);
    saveMemoryEmbedding(db, memoryId, model, v);
    return memoryId;
  }

  it("une las memorias parecidas una vez y deja fuera lo que no llega al umbral", () => {
    const a = withVector("luces del teclado", vec(1, 0, 0));
    const b = withVector("nitro-kb controla las luces", vec(0.95, 0.31, 0));
    const c = withVector("la deuda del cashflow", vec(0, 0, 1));

    const links = relatedLinks(db, [a, b, c], { minScore: 0.75 });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "related" });
    expect([links[0]?.source, links[0]?.target].sort()).toEqual([a, b].sort());
    expect(links[0]?.score).toBeGreaterThan(0.9);
  });

  it("cada memoria aporta como mucho perNode vecinas", () => {
    // a-b 0,99, a-c 0,97, b-c 0,995: con una vecina por memoria, a elige b, b y c se eligen
    // entre sí, y a-c (que nadie eligió primero) queda fuera.
    const a = withVector("a", vec(1, 0));
    const b = withVector("b", vec(0.99, 0.141));
    const c = withVector("c", vec(0.97, 0.243));
    const pairs = (perNode: number) =>
      relatedLinks(db, [a, b, c], { minScore: 0.9, perNode })
        .map((l) => [l.source, l.target].sort().join("|"))
        .sort();
    expect(pairs(1)).toEqual([[a, b].sort().join("|"), [b, c].sort().join("|")].sort());
    expect(pairs(3)).toHaveLength(3);
  });

  it("no compara vectores de modelos distintos", () => {
    const a = withVector("uno", vec(1, 0), "modelo-a");
    const b = withVector("dos", vec(1, 0), "modelo-a");
    const c = withVector("tres", vec(1, 0), "modelo-b");
    const links = relatedLinks(db, [a, b, c], { minScore: 0.5 });
    expect(links).toHaveLength(1);
    expect([links[0]?.source, links[0]?.target]).not.toContain(c);
  });

  it("/api/graph sólo las incluye con related=1", () => {
    withVector("uno", vec(1, 0));
    withVector("dos", vec(1, 0));
    const plain = call((res) => handleGraph(db, res, url("/api/graph"))).body;
    expect(plain.links.some((l: { kind: string }) => l.kind === "related")).toBe(false);
    const related = call((res) => handleGraph(db, res, url("/api/graph?related=1"))).body;
    expect(related.links.filter((l: { kind: string }) => l.kind === "related")).toHaveLength(1);
  });
});
