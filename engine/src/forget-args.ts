/**
 * Argumentos de mismem-forget. Aparte del CLI, que corre al importarse, para poder probarlos.
 *
 * Es estricto a propósito: el CLI borra por defecto, así que un flag que no se entiende
 * (un `--dryrun` mal escrito) no puede quedar ignorado y dejar correr la purga real.
 */
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";
import { Scope } from "./schema.js";

export interface ForgetArgs {
  scope?: string;
  beforeDays: number;
  memoryGraceDays: number;
  salienceBelow: number;
  dryRun: boolean;
  help: boolean;
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
    else if (a === "--scope") {
      // El mismo límite que el schema de forget: si no, Zod lo rechazaba tras abrir la base, con exit 1.
      out.scope = flagValue(argv, i++, a);
      if (!Scope.safeParse(out.scope).success) throw new ArgsError(`--scope admite hasta 128 caracteres`);
    }
    else if (a === "--before-days") out.beforeDays = flagNumber(argv, i++, a, { integer: true, min: 1 });
    else if (a === "--memory-grace-days") out.memoryGraceDays = flagNumber(argv, i++, a, { integer: true, min: 0 });
    // Mismo rango que el schema de `forget` (0..1): fuera de ahí Zod cortaba con exit 1 tras abrir la base.
    else if (a === "--salience-below") out.salienceBelow = flagNumber(argv, i++, a, { min: 0, max: 1 });
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
