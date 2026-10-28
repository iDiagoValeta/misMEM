import { describe, expect, it } from "vitest";
import { mergePages } from "../ui/src/lib/pages";

const row = (id: string): { id: string; text: string } => ({ id, text: `texto de ${id}` });

describe("mergePages", () => {
  it("quita los ids repetidos entre páginas y conserva el primer orden", () => {
    const merged = mergePages([
      [row("a"), row("b"), row("c")],
      [row("c"), row("d"), row("e")],
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("conserva la primera aparición de una fila repetida", () => {
    const first = row("a");
    const merged = mergePages([[first], [row("b"), { ...first, text: "copia desplazada" }]]);
    expect(merged[0]).toBe(first);
  });

  it("con una sola página no toca el orden", () => {
    expect(mergePages([[row("b"), row("a")]]).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("sin páginas devuelve una lista vacía", () => {
    expect(mergePages([])).toEqual([]);
  });
});
