const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "hace 3 días": lo que importa de un recuerdo es cuánto hace, no la fecha exacta. */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "nunca";
  const diff = ts - now;
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return "ahora";
}

export const exact = (ts: number): string => absolute.format(new Date(ts));

/**
 * Cuánta tinta lleva un recuerdo: la salience de hoy entre 0 y 1, llevada a un rango
 * legible. Lo que se olvida se aclara, pero nunca hasta no poder leerse.
 */
export function ink(salience: number | undefined): string {
  const s = Math.max(0, Math.min(1, salience ?? 1));
  return `${Math.round(38 + 62 * s)}%`;
}

export const percent = (value: number): string => `${Math.round(value * 100)} %`;
