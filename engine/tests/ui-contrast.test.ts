import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../ui/src/lib/contrast";

const CSS_PATH = fileURLToPath(new URL("../ui/src/styles.css", import.meta.url));

function themeTokens(selector: RegExp): Map<string, string> {
  const css = readFileSync(CSS_PATH, "utf8");
  const block = css.match(selector)?.[1];
  if (!block) throw new Error(`styles.css no tiene el bloque ${selector}`);
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

function hex(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`falta --color-${name}`);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--color-${name} no es #rrggbb: ${value}`);
  return value;
}

describe("contrastRatio", () => {
  it("da 21 entre negro y blanco", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
});

describe("contraste de los tokens de texto", () => {
  const themes = [
    ["oscuro", /:root\s*,\s*\[data-theme="dark"\]\s*\{([^}]*)\}/],
    ["claro", /\[data-theme="light"\]\s*\{([^}]*)\}/],
  ] as const;

  it("ink, ink-soft, ink-muted y brand-text pasan AA sobre las dos superficies", () => {
    for (const [theme, selector] of themes) {
      const tokens = themeTokens(selector);
      for (const foreground of ["ink", "ink-soft", "ink-muted", "brand-text"]) {
        for (const background of ["surface", "surface-raised"]) {
          const ratio = contrastRatio(hex(tokens, foreground), hex(tokens, background));
          expect(ratio, `${theme}: ${foreground} sobre ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    }
  });
});
