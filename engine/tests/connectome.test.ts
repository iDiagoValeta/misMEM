import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, reinforce } from "../src/tools.js";
import { reinforceMemories } from "../src/salience.js";
import { associationStrength, coUseEdges, hubs, turnsRegistered } from "../src/connectome.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

function memory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
}

/** Un turno de uso medido: lo que el hook `Stop` manda cuando la respuesta usó recuerdos. */
const turno = (...ids: string[]): void => {
  reinforce(db, { memory_ids: ids });
};

const strengthOf = (a: string, b: string): number => {
  const [x, y] = a < b ? [a, b] : [b, a];
  const edge = coUseEdges(db).find((e) => e.memory_a === x && e.memory_b === y);
  if (!edge) throw new Error("ese par no está en co_use");
  return edge.strength;
};

describe("contador de turnos", () => {
  it("arranca en cero", () => {
    expect(turnsRegistered(db)).toBe(0);
  });

  it("cuenta un turno por cada uso medido, aunque sea de un solo recuerdo", () => {
    // El denominador tiene que incluir los turnos de un recuerdo solo: si no,
    // un recuerdo que se usa siempre solo parecería menos frecuente de lo que es.
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    turno(a);
    turno(a, b);

    expect(turnsRegistered(db)).toBe(2);
  });

  it("no lo mueve la aparición en un recall", () => {
    const a = memory("el deploy usa docker compose");

    reinforceMemories(db, [a]);

    expect(turnsRegistered(db)).toBe(0);
  });

  it("no cuenta un turno si ningún id existía", () => {
    reinforce(db, { memory_ids: ["01INVENTADO000000000000000"] });

    expect(turnsRegistered(db)).toBe(0);
  });
});

describe("fuerza de asociación", () => {
  it("es 1 cuando dos recuerdos sólo aparecen juntos", () => {
    expect(associationStrength({ n: 3, useA: 3, useB: 3, turns: 6 })).toBeCloseTo(1, 5);
  });

  it("es 0 cuando uno está en todos los turnos: saberlo no informa nada", () => {
    // El caso del rich club: la identidad y el pacto se usan en todos los turnos,
    // así que su co-uso con cualquier cosa es exactamente lo esperable por azar.
    expect(associationStrength({ n: 5, useA: 10, useB: 5, turns: 10 })).toBeCloseTo(0, 5);
  });

  it("es negativa cuando dos recuerdos se evitan más de lo esperable", () => {
    expect(associationStrength({ n: 1, useA: 8, useB: 8, turns: 10 })).toBeLessThan(0);
  });

  it("no explota sin turnos ni sin usos", () => {
    expect(associationStrength({ n: 0, useA: 0, useB: 0, turns: 0 })).toBe(0);
    expect(associationStrength({ n: 1, useA: 0, useB: 1, turns: 1 })).toBe(0);
  });
});

describe("el conteo crudo y la fuerza no dicen lo mismo", () => {
  it("el par con más co-usos no es el más fuerte", () => {
    // H es el recuerdo que se usa en todos los turnos. X lo acompaña en la mitad.
    // A y B se usan poco, pero nunca por separado.
    const h = memory("hablamos en español y sin rodeos");
    const x = memory("el deploy usa docker compose");
    const a = memory("el bench corre con el embedder arriba");
    const b = memory("el banco de preguntas es privado");

    for (let i = 0; i < 5; i++) turno(h, x);
    for (let i = 0; i < 5; i++) turno(h);
    turno(a, b);
    turno(a, b);

    const hx = coUseEdges(db).find((e) => e.memory_a === (h < x ? h : x))!;
    expect(hx.n).toBe(5);
    expect(strengthOf(a, b)).toBeGreaterThan(strengthOf(h, x));
    expect(strengthOf(a, b)).toBeCloseTo(1, 5);
  });
});

describe("aristas del conectoma", () => {
  it("devuelve el par con su conteo, su fuerza y cuándo fue la última vez", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a, b] }, { at: 1_700_000_000_000 });

    const edges = coUseEdges(db);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ n: 1, last_at: 1_700_000_000_000 });
    expect(typeof edges[0]?.strength).toBe("number");
  });

  it("filtra por soporte mínimo, que es lo que separa la señal del par de una sola vez", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    const c = memory("el bench corre con el embedder arriba");

    turno(a, b);
    turno(a, b);
    turno(a, c);

    expect(coUseEdges(db, { minN: 2 })).toHaveLength(1);
    expect(coUseEdges(db, { minN: 1 })).toHaveLength(2);
  });

  it("acotado a un conjunto de ids, no trae aristas que apunten afuera", () => {
    // El grafo del viewer está recortado: una arista hacia un nodo que no se
    // dibuja es una referencia colgada que rompe el render.
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    const afuera = memory("esto no entra en el grafo");

    turno(a, b);
    turno(a, afuera);

    const edges = coUseEdges(db, { ids: [a, b] });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.memory_a).toBe(a < b ? a : b);
  });

  it("sin uso medido no hay aristas", () => {
    memory("el deploy usa docker compose");

    expect(coUseEdges(db)).toEqual([]);
  });
});

describe("hubs", () => {
  it("ordena por fuerza sumada y no por cantidad de vecinos", () => {
    // El que tiene más vecinos es el que se usa en todos los turnos, y es
    // justamente el que no orienta a ninguno.
    const h = memory("hablamos en español y sin rodeos");
    const v1 = memory("el deploy usa docker compose");
    const v2 = memory("el backup corre a las tres");
    const v3 = memory("el bench corre con el embedder arriba");
    const par1 = memory("el ordenador de memoria tiene tres fases");
    const par2 = memory("la fase dos espera datos de co-uso");

    for (let i = 0; i < 4; i++) turno(h, v1, v2, v3);
    for (let i = 0; i < 8; i++) turno(h);
    for (let i = 0; i < 4; i++) turno(par1, par2);

    const ranking = hubs(db);
    expect(ranking[0]?.id).not.toBe(h);
    expect(ranking.find((x) => x.id === h)!.degree).toBeGreaterThan(
      ranking.find((x) => x.id === par1)!.degree,
    );
    expect(ranking.find((x) => x.id === par1)!.strength).toBeGreaterThan(
      ranking.find((x) => x.id === h)!.strength,
    );
  });

  it("sin turnos no hay hubs", () => {
    memory("el deploy usa docker compose");

    expect(hubs(db)).toEqual([]);
  });
});
