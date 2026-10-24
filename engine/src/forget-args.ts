/**
 * Argumentos de mismem-forget. Aparte del CLI, que corre al importarse, para poder probarlos.
 *
 * Es estricto a propósito: el CLI borra por defecto, así que un flag que no se entiende
 * (un `--dryrun` mal escrito) no puede quedar ignorado y dejar correr la purga real.
 */

export interface ForgetArgs {
  scope?: string;
  beforeDays: number;
  memoryGraceDays: number;
  salienceBelow: number;
  dryRun: boolean;
  help: boolean;
}

export class ArgsError extends Error {
  override name = "ArgsError";
}

function valueOf(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new ArgsError(`${flag} necesita un valor`);
  return value;
}

function numberOf(argv: readonly string[], i: number, flag: string): number {
  const raw = valueOf(argv, i, flag);
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) throw new ArgsError(`${flag} no es un número: ${raw}`);
  return value;
}

export function parseForgetArgs(argv: readonly string[]): ForgetArgs {
  const out: ForgetArgs = {
    beforeDays: 90,
    memoryGraceDays: 30,
    salienceBelow: 0.1,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scope") out.scope = valueOf(argv, i++, a);
    else if (a === "--before-days") out.beforeDays = numberOf(argv, i++, a);
    else if (a === "--memory-grace-days") out.memoryGraceDays = numberOf(argv, i++, a);
    else if (a === "--salience-below") out.salienceBelow = numberOf(argv, i++, a);
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
