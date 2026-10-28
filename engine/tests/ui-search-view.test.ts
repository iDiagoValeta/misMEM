import { describe, expect, it } from "vitest";
import { viewAfterQuery } from "../ui/src/lib/search-view";

describe("viewAfterQuery", () => {
  it("con texto en el grafo se queda en el grafo", () => {
    expect(viewAfterQuery("graph", "memoria")).toBe("graph");
  });

  it("con texto desde memorias lleva a resultados", () => {
    expect(viewAfterQuery("memories", "memoria")).toBe("results");
  });

  it("con texto desde resultados sigue en resultados", () => {
    expect(viewAfterQuery("results", "memoria")).toBe("results");
  });

  it("sin texto no cambia la vista del grafo", () => {
    expect(viewAfterQuery("graph", "")).toBe("graph");
  });

  it("sin texto no cambia la vista de rasgos", () => {
    expect(viewAfterQuery("traits", "")).toBe("traits");
  });
});
