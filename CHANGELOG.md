# Changelog

## Sin publicar

### Un JSON roto de un solo episodio ya no traba el ámbito

- Si el LLM devuelve JSON inválido con un único episodio, ese episodio queda como ruido
  y la corrida sigue con el resto. Antes el ámbito entero fallaba y la próxima noche
  chocaba contra el mismo episodio.

### Vectores y consolidación más robustos

- Una tanda de vectores que falla ya no deja sin vector a todas las siguientes; recién dos fallas seguidas
  cortan (el servidor está caído). En la primera corrida grande, 660 de 756 memorias nuevas quedaron sin
  vector por una sola tanda lenta.
- Al modelo de embeddings le llegan como mucho 4000 caracteres por memoria (`MISMEM_EMBEDDING_MAX_CHARS`):
  el resumen va adelante y no se pierde, y en CPU ARM rinde mucho más.
- La consolidación rellena vectores de a 8.
- Un JSON mal armado del LLM parte la tanda y reintenta, como una respuesta cortada.

### Embeddings desde cualquier servidor compatible con OpenAI

- `MISMEM_EMBEDDING_PROVIDER=openai` + `MISMEM_EMBEDDING_URL` piden `/v1/embeddings` (p. ej. llama-server);
  Ollama sigue siendo el default y no cambia.
- Prefijos distintos para consulta y documento (`MISMEM_EMBEDDING_QUERY_PREFIX` / `_DOC_PREFIX`).
- Corte de parecido configurable (`MISMEM_EMBEDDING_MIN_SCORE`, default 0,5).
- Medido sobre una copia real (1.353 memorias, 80 preguntas con otras palabras): con EmbeddingGemma 2,
  sus prefijos y corte 0,68, el recuerdo correcto sale entre los 5 primeros en 73 de 80 y ninguna de
  10 preguntas ajenas trae recuerdos (con nomic y 0,5 traían las 10).

### La consolidación vuelve a andar y tiene el costo acotado

- `DEEPSEEK_API_KEY` consolida con DeepSeek directo; OpenRouter queda como alternativa.
- Cada llamada pide como mucho 8192 tokens de respuesta, el máximo de `deepseek-chat`. Antes no había
  tope, OpenRouter reservaba unos 100.000 por llamada y respondía HTTP 402 por saldo.
- Si una respuesta igual llega cortada (`finish_reason: length`), la tanda se parte a la mitad y se
  reintenta; el ámbito sigue con ese tamaño. Antes se perdía la tanda entera con "JSON inválido".
- Un ámbito se consolida en tandas que entran en un presupuesto de caracteres; un episodio enorme viaja
  recortado (principio y final). Antes las tandas grandes pasaban el contexto del modelo (163.840
  tokens) y volvían con HTTP 400.
- Un ámbito se vacía en la misma corrida, hasta un tope de 60 llamadas por noche.
- Un 401/402/403 corta la corrida en el primer error en vez de repetirse por cada ámbito.
- Los episodios que el LLM leyó y no citó en ninguna memoria quedan como ruido (`[noise] N episodios sin
  citar`, saliencia 0,05) y no se vuelven a mandar ni a pagar. Si la tanda no dio ninguna memoria válida,
  quedan pendientes como antes.

### La relevancia manda sobre la saliencia

- La saliencia sólo desempata entre recuerdos casi igual de relevantes
  (`SALIENCE_RRF_WEIGHT` 0.02 → 0.0002). Antes un recuerdo muy usado tapaba al
  correcto: sobre una copia real (1.353 memorias, 80 preguntas con otras
  palabras), el correcto entraba entre los 5 primeros 4 veces; ahora 18, y 73
  con un modelo de embeddings multilingüe.
- La búsqueda por palabras ordena por coincidencia (bm25) y después por
  saliencia; la semántica desempata por saliencia a igual parecido.

## 0.3.0 — 2026-07-28

### Decay y olvido coherentes

- Decay exponencial de `salience` con checkpoint idempotente y vida media
  configurable (90 días por defecto).
- El refuerzo Hebbiano aplica primero el decay pendiente y actualiza el
  checkpoint de la memory.
- `forget --dry-run` calcula elegibilidad sin escribir; las memories tienen
  período de gracia y al purgarlas elimina sus episodes consolidados para que
  no reaparezcan.
- Migración automática y aditiva para DBs existentes.

### Recall híbrido consistente

- FTS5 y semántica se ejecutan sobre candidatos independientes de `limit`.
- Fusión RRF con salience, conservando prioridad traits > memories > episodes.
- MCP `recall`, `mem_search`, Engram directo y viewer comparten el mismo núcleo.
- El viewer no aplica refuerzo y vuelve a ser realmente read-only.
- Descripciones MCP actualizadas; `mem_context` permanece como contexto reciente.

### Índice semántico seguro

- No se mezclan modelos ni dimensionalidades incompatibles.
- Cambiar de modelo reindexa automáticamente sin borrar el vector anterior si
  Ollama falla.
- `mismem-embed --status` diagnostica el índice y `--force` permite reconstruirlo.
- Actualizar una memory invalida su embedding para el siguiente backfill.

### Documentación y calidad

- Explicación concisa de episodes, memories y traits.
- 80+ tests incluyendo decay, migraciones, consistencia entre superficies,
  propiedad de prefijo y cambio de modelo.
- `better-sqlite3` 12.11.1 para instalaciones precompiladas compatibles con
  Node 24, verificadas en CI junto con Node 22.

## 0.2.0 — 2026-07-24

Los dos "bordes conocidos" de la 0.1.0, liquidados:

### Dedup en captura e ingesta
- `capture` calcula `content_hash` (sha256) y re-capturar el mismo `(scope, body)`
  devuelve el id original en vez de duplicar. Re-ingestar un export completo
  ahora es idempotente.
- Migración automática y aditiva al abrir la DB: backfill de hashes para filas
  existentes (chunked, seguro para DBs grandes en producción).
- `mismem-ingest walk` reporta `chunksDeduped`.

### Búsqueda semántica opcional (recall híbrido)
- `recall` / `mem_search` ahora combinan FTS5 (léxico) con coseno sobre
  embeddings (semántico): "problemas de plata" encuentra "deudas".
- Embeddings vía **Ollama local** (`nomic-embed-text` default). Sin Ollama,
  degradación silenciosa a FTS5 puro — cero configuración obligatoria.
- Sin extensiones nativas: vectores como BLOB en la misma SQLite, coseno
  brute-force en JS (para memoria personal de miles de filas, <50ms).
- Nueva CLI `mismem-embed` para backfill idempotente; la consolidación
  nocturna embebe automáticamente las memorias nuevas.
- Hits semánticos marcados con `via: "semantic"` y con refuerzo Hebbiano.
- Env: `MISMEM_EMBEDDINGS=off`, `MISMEM_OLLAMA_URL`, `MISMEM_EMBEDDING_MODEL`.

## 0.1.0 — 2026-07-24

Primera versión pública. Historia condensada del desarrollo (abril–julio 2026):

### Núcleo (abril 2026)
- Engine MCP stdio con schema de 3 capas (`episodes` → `memories` → `traits`),
  las 5 invocaciones (`capture`, `recall`, `consolidate`, `crystallize`, `forget`),
  FTS5 + refuerzo Hebbiano en recall, scopes jerárquicos y suite de tests (Vitest).
- Servidor **Streamable HTTP** stateless (server+transport por request) con capa
  **engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …)
  para clientes que hablan el protocolo Engram.
- Dockerfile multi-arch (`mismem-brain`, Alpine) + guía de deploy con Traefik
  (TLS, BasicAuth, healthcheck) y estrategia de backup diario
  (`VACUUM INTO` + scp, retención 14 días).
- Viewer read-only en `/viewer` + `/api/{stats,recent,search}`.
- Fix de robustez: orden estable en `mem_context`, escape seguro de queries FTS5.

### Consolidación LLM (abril 2026)
- Destilación nocturna episodes → memories vía OpenRouter (DeepSeek V3 default):
  idempotente, anti-alucinación (filtra evidencia fuera del batch), memoria stub
  con salience baja cuando no hay señal, tolerante a salidas no conformes del LLM.
- **Pre-filtro Pareto**: clasificador que descarta ruido antes de gastar tokens.
- CLIs: `mismem-ingest` (exports ChatGPT / transcripts VS Code),
  `mismem-consolidate`, `mismem-forget`, `mismem-migrate-engram`, `mismem-stats`.

### Preparación pública (julio 2026)
- Line endings normalizados (`.gitattributes`), docs genéricos sin referencias a
  infraestructura personal, README con arquitectura y quickstart, historial fresco.
