/**
 * Lectura estricta de flags para los CLIs que borran o gastan: un flag que no se
 * entiende corta con error de uso en vez de quedar ignorado y dejar correr otra cosa.
 */

/** EX_USAGE de sysexits.h: distinto del 1 (fallo) y del 2 que usa consolidate para ámbitos fallidos. */
export const EXIT_USAGE = 64;

export class ArgsError extends Error {
  override name = "ArgsError";
}

/** El valor que sigue a `flag` en `argv[i + 1]`; otro `--flag` no cuenta como valor. */
export function flagValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  // Un valor en blanco es un valor ausente: si pasa, el que valida después (`--scope ""`)
  // falla con exit 1 cuando el contrato del CLI es error de uso.
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new ArgsError(`${flag} necesita un valor`);
  }
  return value;
}

export function flagNumber(
  argv: readonly string[],
  i: number,
  flag: string,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const raw = flagValue(argv, i, flag);
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) throw new ArgsError(`${flag} no es un número: ${raw}`);
  if (opts.integer && !Number.isInteger(value)) throw new ArgsError(`${flag} tiene que ser entero: ${raw}`);
  if (opts.min !== undefined && value < opts.min) throw new ArgsError(`${flag} tiene que ser >= ${opts.min}: ${raw}`);
  if (opts.max !== undefined && value > opts.max) throw new ArgsError(`${flag} tiene que ser <= ${opts.max}: ${raw}`);
  return value;
}
