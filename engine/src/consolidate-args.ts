/**
 * Argumentos de mismem-consolidate. Aparte del CLI, que corre al importarse, para poder
 * probarlos. Estricto porque cada corrida cuesta: un `--scope` sin valor consolidaba
 * todos los ámbitos y un número mal escrito dejaba la corrida muda con exit 0.
 */
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";

export interface ConsolidateArgs {
  scope?: string;
  dryRun: boolean;
  minAgeHours?: number;
  minEpisodes?: number;
  quietDays?: number;
  maxBatch?: number;
  uncitedStrikes?: number;
  help: boolean;
}

const POSITIVE_INT = { integer: true, min: 1 };

export function parseConsolidateArgs(argv: readonly string[]): ConsolidateArgs {
  const out: ConsolidateArgs = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scope") out.scope = flagValue(argv, i++, a);
    else if (a === "--min-age-hours") out.minAgeHours = flagNumber(argv, i++, a, { min: 0 });
    else if (a === "--min-episodes") out.minEpisodes = flagNumber(argv, i++, a, POSITIVE_INT);
    else if (a === "--quiet-days") out.quietDays = flagNumber(argv, i++, a, { min: 0 });
    else if (a === "--max-batch") out.maxBatch = flagNumber(argv, i++, a, POSITIVE_INT);
    else if (a === "--uncited-strikes") out.uncitedStrikes = flagNumber(argv, i++, a, POSITIVE_INT);
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
