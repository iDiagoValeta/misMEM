/**
 * La saliencia (0..1) decide cuánta tinta lleva el texto de una memoria. El suelo
 * del 0 % es `ink-muted`, que pasa AA en los dos temas; el 100 % es `ink`. La mezcla
 * la hace el CSS con color-mix, así que aquí sólo se normaliza y se recorta.
 */
export function inkPercent(salience: number): number {
  if (!Number.isFinite(salience)) return 100;
  return Math.round(Math.max(0, Math.min(1, salience)) * 100);
}
