/** Contraste relativo según WCAG 2.x para colores #rrggbb. */

function channel(hex: string, offset: number): number {
  const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  // Corrección gamma de sRGB: por debajo del umbral la respuesta del ojo es lineal.
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrastRatio(a: string, b: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) {
    throw new Error(`contrastRatio espera colores #rrggbb: ${a}, ${b}`);
  }
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
