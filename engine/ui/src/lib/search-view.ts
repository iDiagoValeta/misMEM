/** Las vistas del panel principal. Vive aquí para que la lógica de búsqueda no dependa de React. */
export type View = "memories" | "traits" | "pending" | "results" | "graph";

/**
 * A dónde lleva el texto de la caja de búsqueda. En el grafo el texto filtra en local y
 * al instante: saltar a Resultados desmontaría la vista que se está mirando. Sin texto no
 * se mueve nadie, porque borrar la búsqueda no debe cambiar de pestaña.
 */
export function viewAfterQuery(current: View, query: string): View {
  if (!query.trim()) return current;
  return current === "graph" ? "graph" : "results";
}
