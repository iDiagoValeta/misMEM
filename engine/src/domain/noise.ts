/**
 * Marcadores de ruido: memorias que sólo existen para que `forget` sepa qué episodios
 * borrar (`[noise] …` lo que el LLM descartó, `[pareto:l0] …` lo que el pre-filtro ni
 * le mandó). No son conocimiento: no tienen que competir en el recall ni gastar un
 * embedding. `forget` y el viewer sí los siguen viendo.
 */

export const NOISE_GIST_PREFIXES = ["[noise] ", "[pareto:l0] "] as const;

/** Para medir desde afuera que ningún marcador se escapó al recall. */
export function isNoiseGist(gist: string): boolean {
  return NOISE_GIST_PREFIXES.some((prefix) => gist.startsWith(prefix));
}
