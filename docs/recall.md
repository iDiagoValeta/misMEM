# Cómo busca recall

`recall` devuelve traits, después memories, después episodes. Dentro de las memories fusiona dos señales
con RRF: las palabras (FTS5) y, si hay un servidor de embeddings, el significado. La relevancia va antes
que la saliencia, que sólo desempata. Esta página cuenta el comportamiento; las constantes están en
`engine/src/search.ts` y las variables, en la tabla de [DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Por palabras (siempre)

FTS5 exige que estén **todas** las palabras de la consulta, sin contar las vacías ("qué", "sobre", "the"...).

### El rescate

Si esa consulta estricta no devuelve nada y no hay capa semántica, `recall` reintenta con una consulta OR
y conserva sólo los candidatos que comparten al menos dos términos informativos. Con una sola palabra
basta una; en consultas largas, el 30 % de sus palabras. Devuelve hasta 3 por capa. El rescate alcanza a
rasgos, episodios y memorias, y no altera una búsqueda que ya encontró algo.

## Por significado (opcional)

Con un servidor de embeddings corriendo, `recall` suma búsqueda por significado: "problemas de plata"
encuentra memorias que dicen "deudas". El valor por defecto es Ollama (`ollama pull nomic-embed-text`).
Los vectores se guardan como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro.

La semántica cubre deliberadamente sólo `memories`; `episodes` y `traits` conservan búsqueda FTS5.
Backfill y reindexado: `mismem-embed` (`--status`, `--force`).

También habla con cualquier servidor compatible con OpenAI (`/v1/embeddings`, por ejemplo
`llama-server --embedding`). Para memorias en varios idiomas conviene EmbeddingGemma 2, con sus prefijos y
un corte más alto:

```bash
MISMEM_EMBEDDING_PROVIDER=openai
MISMEM_EMBEDDING_URL=http://127.0.0.1:8080
MISMEM_EMBEDDING_MODEL=embeddinggemma-2
MISMEM_EMBEDDING_QUERY_PREFIX="task: search result | query: "
MISMEM_EMBEDDING_DOC_PREFIX="title: none | text: "
MISMEM_EMBEDDING_MIN_SCORE=0.68
```

La búsqueda sólo compara vectores del modelo configurado. Cambiar de modelo reindexa solo en el siguiente
backfill (`mismem-embed`); cambiar un prefijo no se detecta y exige `mismem-embed --force`. Todas las
variables, con sus defaults, están en
[DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Medirlo

`mismem-bench` informa la posición del acierto (MRR, 1ª, entre las 3), los recuerdos devueltos por
pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0). Se corre antes y después de tocar
`tools.ts`, `search.ts` o `embeddings/`. El banco de preguntas es privado y sale de la propia memoria.
Cómo usarlo en un servidor: [DEPLOY.md](../DEPLOY.md#medir-el-recall).
