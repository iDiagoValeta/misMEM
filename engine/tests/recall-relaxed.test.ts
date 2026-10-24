import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, recall } from "../src/tools.js";

let db: DB;

function memory(scope: string, gist: string): string {
  const e = capture(db, { scope, body: gist });
  return consolidate(db, { scope, gist, source_episode_ids: [e.id] }).memory_id;
}

const memoryIds = (query: string): string[] =>
  recall(db, { query, reinforce: false })
    .hits.filter((h) => h.layer === "memory")
    .map((h) => h.id);

beforeEach(() => {
  db = openDb(":memory:");
});

describe("recall léxico: frases normales", () => {
  it("una pregunta con una forma verbal distinta encuentra la memoria", () => {
    const id = memory("pc", "Las luces del teclado del portátil Acer Nitro se controlan con el comando nitro-kb");
    expect(memoryIds("luces teclado")).toEqual([id]);
    expect(memoryIds("cómo controlo las luces del teclado del portátil")).toEqual([id]);
    expect(
      memoryIds(
        "oye, ayer estuve mirando lo del portátil y no me acuerdo de cómo se cambiaban las luces del teclado, me lo recuerdas",
      ),
    ).toEqual([id]);
  });

  it("un plural encuentra el singular", () => {
    const id = memory("finanzas", "la deuda del cashflow quedó saldada en septiembre");
    expect(memoryIds("deudas")).toEqual([id]);
  });

  it("si la búsqueda estricta encuentra algo, el resultado no cambia", () => {
    const exact = memory("dev", "deploy de florfitt con docker compose y traefik");
    memory("dev", "docker en el portátil para pruebas locales");
    expect(memoryIds("florfitt docker")).toEqual([exact]);
  });

  it("al relajar hacen falta dos palabras: una sola en común no alcanza", () => {
    const both = memory("pc", "el teclado retroiluminado tiene luces RGB");
    memory("pc", "el teclado mecánico nuevo");
    expect(memoryIds("cambiar luces del teclado ahora")).toEqual([both]);
  });

  it("al relajar, lo que coincide en más palabras va primero", () => {
    const three = memory("pc", "las luces del teclado del portátil");
    const two = memory("pc", "luces del teclado externo");
    expect(memoryIds("cómo apago las luces del teclado de mi portátil")).toEqual([three, two]);
  });
});
