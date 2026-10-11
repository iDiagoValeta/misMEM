/**
 * Medición del recall contra un banco de preguntas propio.
 *
 * El banco es privado (sale de la memoria de cada uno) y vive fuera del repo.
 * Nunca refuerza: medir no puede cambiar lo que después se recuerda.
 */
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import type { EmbedFn } from "./embeddings/index.js";
import { recallHybrid } from "./tools.js";

const BankLine = z.object({ id: z.string().min(1) }).catchall(z.string());

export interface BankEntry {
  id: string;
  groups: Record<string, string>;
  queries: Record<string, string>;
}

export interface Bank {
  variants: string[];
  entries: BankEntry[];
}

export interface Score {
  found: number;
  total: number;
}

export interface BenchReport {
  limit: number;
  variants: Record<string, { all: Score; groups: Record<string, Score> }>;
  offTopic: { withHits: number; total: number };
}

export interface BenchOptions {
  limit: number;
  embedFn?: EmbedFn;
  offTopic?: string[];
}

/** Una línea JSON por pregunta: `id` de la memoria esperada, claves de grupo y una clave por variante. */
export function parseBank(text: string, groupKeys: string[]): Bank {
  const variants: string[] = [];
  const entries: BankEntry[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: z.infer<typeof BankLine>;
    try {
      parsed = BankLine.parse(JSON.parse(line));
    } catch (err) {
      throw new Error(`banco inválido en la línea ${index + 1}: ${(err as Error).message}`);
    }
    const entry: BankEntry = { id: parsed.id, groups: {}, queries: {} };
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "id") continue;
      if (groupKeys.includes(key)) {
        entry.groups[key] = value;
        continue;
      }
      entry.queries[key] = value;
      if (!variants.includes(key)) variants.push(key);
    }
    entries.push(entry);
  });
  return { variants, entries };
}

function bump(score: Score | undefined, found: boolean): Score {
  const next = score ?? { found: 0, total: 0 };
  return { found: next.found + (found ? 1 : 0), total: next.total + 1 };
}

export async function runBench(db: DB, bank: Bank, opts: BenchOptions): Promise<BenchReport> {
  const report: BenchReport = {
    limit: opts.limit,
    variants: {},
    offTopic: { withHits: 0, total: 0 },
  };
  const ask = async (query: string) =>
    (await recallHybrid(db, { query, limit: opts.limit }, opts.embedFn, { reinforce: false })).hits;

  for (const variant of bank.variants) {
    const result: { all: Score; groups: Record<string, Score> } = {
      all: { found: 0, total: 0 },
      groups: {},
    };
    for (const entry of bank.entries) {
      const query = entry.queries[variant];
      if (!query) continue;
      const found = (await ask(query)).some((hit) => hit.id === entry.id);
      result.all = bump(result.all, found);
      for (const [key, value] of Object.entries(entry.groups)) {
        const label = `${key}=${value}`;
        result.groups[label] = bump(result.groups[label], found);
      }
    }
    report.variants[variant] = result;
  }

  for (const query of opts.offTopic ?? []) {
    const hits = await ask(query);
    report.offTopic = {
      withHits: report.offTopic.withHits + (hits.length > 0 ? 1 : 0),
      total: report.offTopic.total + 1,
    };
  }
  return report;
}
