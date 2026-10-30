// Owns the writes the viewer can trigger: correcting a memory, undoing its consolidation, and
// forgetting a memory or a trait. The confirmation flow stays in the HTTP layer; here the
// deletion only happens when it is called.
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { embedPendingMemories } from "../embeddings/store.js";

export type Reembed = (db: DB) => Promise<unknown>;

const EditInput = z.object({
  gist: z.string().trim().min(1).max(2000),
  details: z.string().max(20_000).nullable().optional(),
});

export async function editMemory(
  db: DB,
  id: string,
  raw: unknown,
  reembed: Reembed = (db) => embedPendingMemories(db),
): Promise<{ id: string; reembedded: boolean }> {
  const input = EditInput.parse(raw);
  db.transaction(() => {
    db.prepare("UPDATE memories SET gist = ?, details = ? WHERE id = ?").run(
      input.gist,
      input.details?.trim() || null,
      id,
    );
    // El vector viejo describe otro texto: sin borrarlo, la búsqueda semántica seguiría
    // encontrando la memoria por lo que decía antes.
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
  })();
  try {
    await reembed(db);
    return { id, reembedded: true };
  } catch {
    // Sin embedder la memoria se sigue encontrando por palabras; el backfill la recupera.
    return { id, reembedded: false };
  }
}

/** Deshace la consolidación: los episodios vuelven a pendientes por el ON DELETE SET NULL. */
export function unconsolidateMemory(db: DB, id: string): { id: string; episodes_released: number } {
  return db.transaction(() => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into = ?").get(id) as {
      n: number;
    };
    // Vuelven sin strikes: que el LLM no los citara antes no dice nada de la próxima vez.
    db.prepare("UPDATE episodes SET uncited_count = 0 WHERE consolidated_into = ?").run(id);
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return { id, episodes_released: n };
  })();
}

/** Olvida como `forget`: la memoria y lo que la respaldaba. */
export function forgetMemory(db: DB, id: string): { id: string; episodes_deleted: number } {
  return db.transaction(() => {
    const episodes = db.prepare("DELETE FROM episodes WHERE consolidated_into = ?").run(id).changes;
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return { id, episodes_deleted: episodes };
  })();
}

export function forgetTrait(db: DB, id: string): { id: string } {
  db.prepare("DELETE FROM traits WHERE id = ?").run(id);
  return { id };
}
