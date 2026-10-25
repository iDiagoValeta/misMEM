import { describe, expect, it } from "vitest";
import { inkPercent } from "../ui/src/lib/ink";

/**
 * La tinta es la única licencia visual del proyecto: la saliencia decide cuánto se
 * acerca el texto a `ink`, pero nunca por debajo de `ink-muted`, que es el suelo que
 * pasa AA. El suelo vive en el CSS; aquí sólo se fija la escala.
 */
describe("inkPercent", () => {
  it("lleva los extremos de 0..1 a 0..100", () => {
    expect(inkPercent(0)).toBe(0);
    expect(inkPercent(1)).toBe(100);
  });

  it("recorta lo que se sale del rango", () => {
    expect(inkPercent(1.7)).toBe(100);
    expect(inkPercent(-1)).toBe(0);
  });

  it("redondea para que color-mix reciba un porcentaje entero", () => {
    expect(inkPercent(0.426)).toBe(43);
  });
});
