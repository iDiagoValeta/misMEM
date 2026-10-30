// The write behind `mem_update`: an id names a memory or a trait, and its text is replaced.
// A miss returns null so the alias can append an episode instead; composing that capture is
// the alias's job, not this module's.
import type { Database as DB } from "better-sqlite3";

export type EngramUpdateTarget = "memory" | "trait";

export function updateEngramTarget(
  db: DB,
  id: string,
  content: string,
  at: number,
): EngramUpdateTarget | null {
  return db.transaction((): EngramUpdateTarget | null => {
    const memory = db.prepare("UPDATE memories SET gist = ? WHERE id = ?").run(content, id);
    if (memory.changes > 0) {
      // El vector viejo describe otro texto: sin borrarlo, la búsqueda semántica seguiría
      // encontrando la memoria por lo que decía antes. El backfill la vuelve a calcular.
      db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      return "memory";
    }
    const trait = db
      .prepare("UPDATE traits SET name = ?, updated_at = ? WHERE id = ?")
      .run(content, at, id);
    return trait.changes > 0 ? "trait" : null;
  })();
}
