/**
 * El presupuesto de una llamada: cuánto viaja de cada episodio y cuándo la tanda deja
 * de crecer. Lo que no entra queda pendiente para la tanda siguiente.
 */
import type { EpisodeForPrompt } from "./prompts.js";

// Lo que buildUserPrompt suma por episodio: id, fecha y separador.
const PROMPT_OVERHEAD_PER_EPISODE = 60;
const TRUNCATION_MARK = "\n[recortado]\n";

/** Los topes de una tanda; `maxEpisodes` baja cuando el LLM corta la respuesta. */
export interface PromptBudget {
  maxEpisodes: number;
  maxPromptChars: number;
  maxEpisodeChars: number;
}

export function truncateEpisode(body: string, max: number): string {
  if (body.length <= max) return body;
  const room = max - TRUNCATION_MARK.length;
  // Un tope más chico que la marca daría cortes negativos y un texto más largo que el tope.
  if (room <= 0) return body.slice(0, Math.max(0, max));
  const head = Math.ceil(room * 0.75);
  return body.slice(0, head) + TRUNCATION_MARK + body.slice(body.length - (room - head));
}

/**
 * Los episodios que entran en la tanda, ya recortados. El primero entra siempre, aunque
 * no quepa: uno solo tiene que poder viajar para que su error diga algo del episodio.
 */
export function fitPrompt(episodes: EpisodeForPrompt[], budget: PromptBudget): EpisodeForPrompt[] {
  const fitted: EpisodeForPrompt[] = [];
  let used = 0;
  for (const e of episodes) {
    if (fitted.length >= budget.maxEpisodes) break;
    const body = truncateEpisode(e.body, budget.maxEpisodeChars);
    const cost = body.length + PROMPT_OVERHEAD_PER_EPISODE;
    if (fitted.length > 0 && used + cost > budget.maxPromptChars) break;
    fitted.push({ id: e.id, body, created_at: e.created_at });
    used += cost;
  }
  return fitted;
}
