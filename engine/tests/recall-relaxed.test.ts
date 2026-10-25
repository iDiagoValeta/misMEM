import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, recall, recallHybrid } from "../src/tools.js";
import { embedPendingMemories, type EmbedFn } from "../src/embeddings/index.js";

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

  it("una pregunta ajena y larga con dos palabras comunes no rescata nada", () => {
    memory("jardin", "el sistema tiene un riego automático para el jardín");
    expect(
      memoryIds("¿cuántos planetas del sistema solar tiene anillos y cuántas lunas rodean a Júpiter?"),
    ).toEqual([]);
  });

  it("una palabra común no rescata si no la acompañan dos raras", () => {
    // Ocho memorias de fondo hacen que "sistema" y "equipo" sean vocabulario común:
    // cada una aparece en cuatro documentos, por encima del umbral de rareza.
    for (const gist of [
      "sistema de archivos del servidor",
      "sistema de energía del portátil",
      "sistema de notificaciones del móvil",
      "equipo de fútbol del barrio",
      "equipo de diseño de la oficina",
      "equipo de música del salón",
      "receta de masa madre",
      "el clima de A Coruña",
    ]) {
      memory("pc", gist);
    }
    // "sistema" y "equipo" coinciden, pero no distinguen: son comunes.
    memory("pc", "el sistema del equipo de riego");
    // Una sola palabra rara tampoco basta.
    memory("dev", "kubernetes en el cluster");
    const two = memory("dev", "despliegue de kubernetes con traefik en el ingress");

    expect(memoryIds("sistema equipo kubernetes traefik")).toEqual([two]);
  });

  it("el rescate devuelve como mucho tres recuerdos", () => {
    for (const suffix of ["uno", "dos", "tres", "cuatro", "cinco"]) {
      memory("dev", `configurar servidor nginx ${suffix}`);
    }
    expect(memoryIds("configurando servidores nginx")).toHaveLength(3);
  });

  it("con la búsqueda estricta llena, el rescate no añade nada", () => {
    const exact = memory("dev", "deploy de florfitt con docker y traefik");
    memory("dev", "florfitt usa docker a diario");
    expect(memoryIds("florfitt docker traefik")).toEqual([exact]);
  });
});

describe("recall híbrido: el rescate no salta el corte semántico", () => {
  it("un recuerdo que sólo llega por palabras y no pasa el corte se descarta", async () => {
    const lexico = memory("dev", "configurar servidor");
    const semantico = memory("finanzas", "temas de finanzas");
    const vecs = new Map<string, Float32Array>([
      ["configurando servidores", Float32Array.from([1, 0])],
      ["configurar servidor", Float32Array.from([0, 1])],
      ["temas de finanzas", Float32Array.from([1, 0])],
    ]);
    const embed: EmbedFn = async (texts) =>
      texts.map((text) => vecs.get(text) ?? Float32Array.from([0, 1]));
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const result = await recallHybrid(
      db,
      { query: "configurando servidores", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toEqual([semantico]);
    expect(result.hits.map((hit) => hit.id)).not.toContain(lexico);
  });
});
