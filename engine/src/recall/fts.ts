// Owns FTS5 query syntax: quoting, escaping and token splitting. Kept apart from the
// rescue and the ranking so a change to how a term is quoted has one home.
import { searchTerms } from "../domain/terms.js";

export const quoteFts = (term: string): string => `"${term.replace(/"/g, '""')}"`;

export function escapeFts(query: string): string {
  // Cada palabra entre comillas: FTS5 las une con AND y los caracteres especiales no rompen el MATCH.
  // Sin palabras, un término vacío no matchea nada y evita una expresión inválida.
  const escaped = searchTerms(query).map(quoteFts).join(" ");
  return escaped || '""';
}

// El rescate puntúa con el mismo tokenizador que indexa FTS5 (unicode61): `_` y cualquier
// signo separan palabras. Si un lado parte y el otro no, se recupera por un criterio y se
// cuenta por otro, y el candidato se descarta con cero coincidencias.
export const FTS_TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
