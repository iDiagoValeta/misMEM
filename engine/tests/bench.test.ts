import { beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate } from "../src/tools.js";
import { embedPendingMemories, type EmbedFn } from "../src/embeddings/index.js";
import { parseBank, runBench } from "../src/bench.js";

let db: DB;

function fakeVec(text: string): Float32Array {
  const vec = new Float32Array(2);
  if (/deuda|plata|finanzas/.test(text.toLowerCase())) vec[0] = 1;
  if (/docker|deploy|servidor/.test(text.toLowerCase())) vec[1] = 1;
  return vec;
}

const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);

function makeMemory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
}

beforeEach(async () => {
  db = openDb(":memory:");
});

describe("parseBank", () => {
  it("toma como variante toda clave de texto que no sea el id ni un grupo", () => {
    const bank = parseBank(
      '{"id":"m1","lang":"en","parafrasis":"a","literal":"b"}\n\n{"id":"m2","lang":"es","parafrasis":"c","literal":"d"}\n',
      ["lang"],
    );
    expect(bank.variants).toEqual(["parafrasis", "literal"]);
    expect(bank.entries).toHaveLength(2);
    expect(bank.entries[0]).toEqual({ id: "m1", groups: { lang: "en" }, queries: { parafrasis: "a", literal: "b" } });
  });

  it("rechaza una línea sin id en vez de saltearla", () => {
    expect(() => parseBank('{"parafrasis":"a"}', [])).toThrow(/línea 1/);
  });
});

describe("runBench", () => {
  it("cuenta acierto sólo cuando la memoria esperada está entre las devueltas", async () => {
    const debts = makeMemory("Tiene deudas con el banco");
    const deploy = makeMemory("El deploy usa docker compose");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    const bank = parseBank(
      [
        JSON.stringify({ id: debts, lang: "es", parafrasis: "problemas de plata" }),
        JSON.stringify({ id: deploy, lang: "en", parafrasis: "problemas de plata" }),
      ].join("\n"),
      ["lang"],
    );
    const report = await runBench(db, bank, { limit: 1, embedFn: fakeEmbed });

    expect(report.variants.parafrasis?.all).toEqual({ found: 1, total: 2 });
    expect(report.variants.parafrasis?.groups["lang=es"]).toEqual({ found: 1, total: 1 });
    expect(report.variants.parafrasis?.groups["lang=en"]).toEqual({ found: 0, total: 1 });
  });

  it("informa cuántas preguntas ajenas trajeron algo", async () => {
    makeMemory("Tiene deudas con el banco");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const bank = parseBank("", []);

    const report = await runBench(db, bank, {
      limit: 5,
      embedFn: fakeEmbed,
      offTopic: ["receta de chimichurri", "problemas de plata"],
    });

    expect(report.offTopic).toEqual({ withHits: 1, total: 2 });
  });

  it("no refuerza: medir no cambia la saliencia de lo que encuentra", async () => {
    const debts = makeMemory("Tiene deudas con el banco");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const before = db.prepare("SELECT salience, last_accessed_at FROM memories WHERE id = ?").get(debts);

    await runBench(db, parseBank(JSON.stringify({ id: debts, q: "problemas de plata" }), []), {
      limit: 5,
      embedFn: fakeEmbed,
    });

    expect(db.prepare("SELECT salience, last_accessed_at FROM memories WHERE id = ?").get(debts)).toEqual(before);
  });
});
