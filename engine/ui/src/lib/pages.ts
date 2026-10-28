/**
 * Concatena páginas ya cargadas sin repetir filas. Paginar por offset con una caché que
 * se invalida entera hace que una escritura desplace filas: la que estaba al final de
 * una página reaparece al principio de la siguiente. Conserva el primer orden porque la
 * página anterior es la que la persona ya estaba leyendo.
 */
export function mergePages<T extends { id: string }>(pages: ReadonlyArray<ReadonlyArray<T>>): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged;
}
