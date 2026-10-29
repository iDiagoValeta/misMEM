// Owns `reinforce` and the Hebbian index it writes: the turn, the per-memory count and
// the pairs used together.
import type { Database as DB } from "better-sqlite3";
import { ReinforceInput } from "../schema.js";
import { registerTurn } from "../store/connectome.js";
import { reinforceMemories } from "./salience.js";

/**
 * Índice hebbiano: cuenta el uso de cada recuerdo y el co-uso de cada par que
 * se usó en el mismo turno. Vive acá y no en `reinforceMemories` porque a esa
 * la llama también el camino de recall, donde aparecer no es haberse usado.
 */
function recordUse(db: DB, memoryIds: readonly string[], at: number): void {
  const ids = [...new Set(memoryIds)].sort();
  if (ids.length === 0) return;

  const countUse = db.prepare("UPDATE memories SET use_count = use_count + 1 WHERE id = ?");
  const pairUse = db.prepare(
    `INSERT INTO co_use (memory_a, memory_b, n, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(memory_a, memory_b) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
  );

  db.transaction(() => {
    // The turn goes in the same transaction as the counts: the denominator must not
    // fall out of step with the numerators, not even through a failure mid-way.
    registerTurn(db);
    for (const id of ids) countUse.run(id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairUse.run(ids[i], ids[j], at);
      }
    }
  })();
}

/**
 * Refuerza los recuerdos que una respuesta usó de verdad.
 *
 * Los rasgos se cuentan aparte en vez de caer en `unknown`: la inyección también los
 * adelanta, así que mezclarlos dejaba esa alarma —la de "alguien manda ids inventados"—
 * sonando desde el primer día. Un rasgo gana fuerza al cristalizar, no al usarse.
 */
export function reinforce(
  db: DB,
  raw: unknown,
  options: { at?: number } = {},
): { reinforced: number; traits: number; unknown: number } {
  const input = ReinforceInput.parse(raw);
  const ids = [...new Set(input.memory_ids)];
  const placeholders = ids.map(() => "?").join(", ");
  const idsIn = (table: string): string[] =>
    (
      db.prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`).all(...ids) as Array<{
        id: string;
      }>
    ).map((row) => row.id);

  const known = idsIn("memories");
  const traits = idsIn("traits");

  reinforceMemories(db, known, { at: options.at, boost: input.boost });
  recordUse(db, known, options.at ?? Date.now());
  return {
    reinforced: known.length,
    traits: traits.length,
    unknown: ids.length - known.length - traits.length,
  };
}
