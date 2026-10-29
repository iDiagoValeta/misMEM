// Owns the lax rescue: its prefix, rarity and minimum-match constants and the scoring that
// decides which candidates survive when the strict query found nothing.
import type { Database as DB } from "better-sqlite3";
import { plain, searchTerms } from "../domain/terms.js";
import { excludeNoiseSql } from "../store/rows.js";
import { FTS_TOKEN_SPLIT, quoteFts } from "./fts.js";
import type { RankedCandidate } from "./lexical.js";

// El tokenizador no reduce a raíz: sin esto "controlo" no encuentra "controlan" ni "deudas"
// encuentra "deuda". Una palabra de 5 letras o más busca por su principio, sin las últimas
// tres (que es donde cambian género, número y conjugación) y nunca por menos de 4.
const PREFIX_FROM_LENGTH = 5;
const PREFIX_TRIM = 3;
const PREFIX_MIN = 4;

// Cuántos términos informativos distintos tienen que coincidir. Con uno se colaría
// cualquier recuerdo que comparta una palabra rara pero ajena; con dos, el candidato tiene
// que hablar de lo mismo por dos sitios. Las palabras comunes no cuentan.
const RELAXED_MIN_INFORMATIVE = 2;
// En una pregunta larga, dos coincidencias no son prueba aunque sean raras: la proporción
// sube el mínimo con el tamaño de la consulta. Se mide sobre TODAS las palabras buscadas,
// no sólo las informativas: en un corpus diminuto casi todo sale raro y dos palabras
// comunes bastan para rescatar una pregunta ajena y larga, como comprueba el test de la
// pregunta de astronomía. Con la base informativa el banco de ajenas seguía a cero, pero
// ese caso se colaba. Las informativas siguen mandando en la cuenta de coincidencias y en
// el orden; aquí sólo fijan cuántas hacen falta.
const RELAXED_MIN_RATIO = 0.3;
// Un término es raro cuando aparece en pocas memorias; los que salen en muchas no
// distinguen una paráfrasis de una casualidad (la idea del IDF de bm25). El suelo de 3
// documentos protege corpus pequeños, donde una fracción sola marcaría casi todo como
// común; la fracción crece con la base para que "pocas" signifique lo mismo en una memoria
// de 300 recuerdos que en una de 3.000. Se calibra con `mismem-bench --off-topic` sobre el
// banco privado: se sube la fracción mientras las preguntas ajenas sigan sin traer nada y
// se elige la mayor que las deje a cero, para rescatar el máximo de paráfrasis sin colar
// falsos positivos.
const RELAXED_RARE_MIN_DOCS = 3;
const RELAXED_RARE_FRACTION = 0.05;
// El rescate es un último recurso, no una segunda lista: tres recuerdos bastan para
// recuperar la paráfrasis y no convierten la respuesta en un volcado. Este es el único
// tope del rescate; el estricto conserva el suyo de candidatos.
const RELAXED_MAX_RESULTS = 3;
// Tope de palabras para que la consulta de rescate no crezca sin límite.
export const RELAXED_MAX_TERMS = 12;

export interface RelaxedTerm {
  word: string;
  /** Principio por el que se busca; null si la palabra es demasiado corta y va exacta. */
  prefix: string | null;
}

interface RelaxedQuery {
  /** Términos que se buscan y se cuentan, ya sin prefijos repetidos. */
  terms: RelaxedTerm[];
  /** Palabras distintas antes de juntar prefijos: dice si la consulta es de una sola. */
  wordCount: number;
}

/**
 * Las palabras del rescate, ya normalizadas y sin repetir. La raíz aproximada sale de los
 * mismos constantes que la búsqueda por prefijo: quitar las últimas tres letras es donde
 * cambian género, número y conjugación. Cada palabra se parte como la parte FTS5, porque
 * un identificador con guion bajo son dos tokens para el índice y uno solo aquí.
 */
export function relaxedTerms(query: string): RelaxedQuery {
  const seen = new Set<string>();
  const terms: RelaxedTerm[] = [];
  for (const term of searchTerms(query)) {
    for (const word of plain(term).split(FTS_TOKEN_SPLIT)) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      terms.push({
        word,
        prefix:
          word.length < PREFIX_FROM_LENGTH
            ? null
            : word.slice(0, Math.max(PREFIX_MIN, word.length - PREFIX_TRIM)),
      });
    }
  }
  return {
    terms: dedupeByPrefix(terms).slice(0, RELAXED_MAX_TERMS),
    wordCount: terms.length,
  };
}

/**
 * Junta los términos que buscan por el mismo principio: `decidir` (`deci`) y `decision`
 * (`decis`) los satisface el mismo token, así que dejarlos sueltos permitiría cumplir el
 * mínimo de dos coincidencias con una sola palabra. Se queda el prefijo más largo, que es
 * el más específico y el que menos candidatos ajenos arrastra.
 */
function dedupeByPrefix(terms: RelaxedTerm[]): RelaxedTerm[] {
  const kept: RelaxedTerm[] = [];
  const prefixes: string[] = [];
  for (const term of terms) {
    const prefix = term.prefix ?? term.word;
    const clash = prefixes.findIndex(
      (other) => prefix.startsWith(other) || other.startsWith(prefix),
    );
    if (clash === -1) {
      kept.push(term);
      prefixes.push(prefix);
    } else if (prefix.length > (prefixes[clash]?.length ?? 0)) {
      kept[clash] = term;
      prefixes[clash] = prefix;
    }
  }
  return kept;
}

/**
 * La consulta de rescate cuando la estricta no encontró nada: una sola expresión con OR de
 * todas las palabras. FTS5 ya no decide si el recuerdo vale; sólo trae candidatos baratos.
 */
export function relaxedFts(terms: RelaxedTerm[]): string {
  const expressions = terms.map(({ word, prefix }) =>
    prefix ? `${quoteFts(prefix)}*` : quoteFts(word),
  );
  return expressions.join(" OR ") || '""';
}

/**
 * En cuántas memorias distintas aparece el término, con el mismo prefijo que usa el
 * rescate. Se mide sobre `memories_fts` (gist + details, el mismo texto que se puntúa) y
 * no sobre la capa que se rescata: las memorias son el corpus consolidado donde se
 * acumula el vocabulario genérico, mientras rasgos y episodios son dispersos y ahí casi
 * todo parecería raro. Ese cero sólo dice que el término no está en las memorias, no que
 * no exista en el recall: rasgos y episodios no viven en esta tabla. Cuenta sin filtrar
 * por scope porque el vocabulario es de la persona, no del proyecto, y así el umbral no
 * cambia de una memoria pequeña a otra grande. El ruido que `forget` conserva no es
 * conocimiento: se excluye igual que en la búsqueda, o empujaría un término real por
 * encima de `rare`.
 */
function documentFrequency(db: DB, term: RelaxedTerm): number {
  const q = term.prefix ? `${quoteFts(term.prefix)}*` : quoteFts(term.word);
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND ${excludeNoiseSql("m")}`,
    )
    .get(q) as { n: number };
  return row.n;
}

/**
 * Los términos que pueden distinguir dentro de este corpus. La frecuencia se mide sólo
 * sobre las memorias, así que un término ausente de ellas sale con 0, el valor más raro
 * posible: no puede casar con ninguna memoria y por eso no altera el rescate de esa capa,
 * pero sí puede casar con un episodio o un rasgo, que no están en `memories_fts`.
 * Descartarlo dejaba esos dos rescates vacíos en cuanto sus palabras no aparecían en
 * ninguna memoria, y con la tabla de memorias vacía pasaba siempre (instalación recién
 * nacida, sin capa semántica), que es justo el caso que el rescate tiene que cubrir.
 * El precio: un episodio que comparta con una pregunta ajena dos palabras ausentes de todas
 * las memorias se rescata ("cambiar la configuración del móvil" frente a la del servidor),
 * tenga la base las memorias que tenga. Lo que lo frena es que esas palabras sean comunes
 * en las memorias, por encima de `rare`. Es el camino degradado, donde traer algo flojo
 * cuesta menos que no traer nada.
 *
 * Un término que sale en todas las memorias también entra: con el corpus diminuto de un
 * test o de una instalación recién nacida, "todos los documentos" no es ruido sino el
 * tema del que hablan, y el IDF no tiene resolución para distinguirlo. En un corpus
 * grande, que una palabra ajena a la consulta aparezca en todas las memorias es
 * improbable; si aparece, es el tema y merece contar. El total sale del mismo conjunto
 * que la frecuencia, sin ruido, para que las dos comparaciones hablen del mismo corpus.
 */
export function informativeTerms(db: DB, terms: RelaxedTerm[]): RelaxedTerm[] {
  const total = (
    db
      .prepare(
        `SELECT count(*) AS n
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE ${excludeNoiseSql("m")}`,
      )
      .get() as { n: number }
  ).n;
  const rare = Math.max(RELAXED_RARE_MIN_DOCS, Math.ceil(total * RELAXED_RARE_FRACTION));
  return terms.filter((term) => {
    const frequency = documentFrequency(db, term);
    return frequency <= rare || frequency === total;
  });
}

/**
 * Cuántos términos informativos distintos de la consulta aparecen en el texto, contando
 * por el mismo prefijo con el que se buscó. Las palabras comunes no entran en la cuenta:
 * coincidir en "sistema" en una pregunta sobre planetas no prueba nada. Los tokens se
 * parten como FTS5 (`_` incluido), o `columna_beta` no casaría con `beta`.
 *
 * Un token más corto que PREFIX_FROM_LENGTH no casa por prefijo. Con el recorte actual,
 * "solar" baja a "sola" y una palabra de cuatro letras puede ser otra cualquiera; sin la
 * guarda, "una sola pasada" contaba como coincidencia de "solar" y rescataba una pregunta
 * ajena. Se pierde el plural que busca un singular de cuatro letras ("flores" → "flor"),
 * que el recorte tampoco encontraba en el sentido contrario.
 */
function countRelaxedMatches(text: string, terms: RelaxedTerm[]): number {
  const tokens = plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
  return terms.reduce((count, { word, prefix }) => {
    const found = tokens.some((token) =>
      prefix
        ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
        : token === word,
    );
    return found ? count + 1 : count;
  }, 0);
}

/**
 * Deja sólo los candidatos del rescate que alcanzan el mínimo de términos informativos y
 * los ordena por esas coincidencias, no por la saliencia ni por la antigüedad. El tope
 * evita que el rescate se convierta en una segunda lista.
 */
export function relaxRows<T extends RankedCandidate>(
  rows: T[],
  informative: RelaxedTerm[],
  queryWords: number,
): T[] {
  if (rows.length === 0 || informative.length === 0) return [];
  // Una consulta de una sola palabra no puede juntar dos coincidencias. No hace falta
  // exigirle longitud: si el rescate llegó aquí es porque el prefijo cambió la consulta, y
  // el prefijo ya exige PREFIX_FROM_LENGTH letras; una palabra corta va exacta y no se
  // rescata. En el resto, la proporción sube el mínimo con el tamaño de la consulta.
  const required =
    queryWords === 1
      ? 1
      : Math.max(RELAXED_MIN_INFORMATIVE, Math.ceil(queryWords * RELAXED_MIN_RATIO));
  // Si no hay tantos términos informativos como exige la consulta, nadie puede llegar.
  if (informative.length < required) return [];
  return rows
    .map((row) => ({
      row,
      matches: countRelaxedMatches(row.search_text ?? row.text, informative),
    }))
    .filter(({ matches }) => matches >= required)
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        Number(a.row.fts_rank) - Number(b.row.fts_rank) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, RELAXED_MAX_RESULTS)
    .map(({ row }) => row);
}
