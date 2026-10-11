# Changelog

## Sin publicar

### Los ámbitos chicos ya no quedan pendientes para siempre

- Un ámbito con menos de `MISMEM_CONSOLIDATION_MIN_EPISODES` episodios se consolida igual cuando lleva
  `MISMEM_CONSOLIDATION_QUIET_DAYS` (14) sin episodios nuevos (`--quiet-days`). Antes una charla importada
  o un proyecto abandonado con uno o dos episodios no se consolidaba nunca y sólo se encontraba por palabras
  exactas. Con muchos ámbitos así, el tope de llamadas por corrida los reparte en varias noches.

### Un episodio que el LLM no logra procesar queda pendiente

- Si con un solo episodio la respuesta llega cortada o con JSON inválido, el episodio queda pendiente
  y la corrida sigue con el resto del ámbito. Antes, con JSON inválido se marcaba como ruido (y `forget`
  lo borraba a los 30 días) y con respuesta cortada el ámbito entero fallaba todas las noches contra el
  mismo episodio.
- El resumen de la corrida informa `episodes_skipped`.

### Documentación: una sola referencia de configuración

- `DEPLOY.md` tiene la única tabla completa de variables de entorno; el README, `engine/README.md`,
  la guía de consolidación y `.github/copilot-instructions.md` enlazan ahí en vez de repetir defaults.
- `DEPLOY.md` documenta lo que faltaba para un despliegue real: el servidor de embeddings, cuándo hay
  que reindexar, las tres tareas programadas (respaldo, consolidación, olvido) y qué texto sale a terceros.
- Corregido lo que ya no era cierto: la consolidación "vía OpenRouter", el TTL de los episodios (no
  existe: los borra `forget`), la firma de `forget`, el esquema y que la memoria "nunca sale de tu máquina"
  (con la consolidación activada, los episodios viajan al proveedor del LLM).

### Medir el recall sin tocarlo

- `mismem-bench --bank <banco.jsonl>` cuenta cuántas veces la memoria esperada sale entre las devueltas,
  por variante de pregunta y por grupo, y cuántas preguntas ajenas traen algo. Usa el mismo recall y el
  mismo servidor de embeddings que producción y no refuerza. El banco es privado y no va al repo.

### Bordes de configuración

- `MISMEM_EMBEDDING_MIN_SCORE=0` se respeta (traer todo); antes volvía a 0,5 sin avisar.
- Con `MISMEM_EMBEDDING_PROVIDER=openai` y sin `MISMEM_EMBEDDING_URL`, el default es
  `http://127.0.0.1:8080` (llama-server). Antes heredaba la URL de Ollama y la búsqueda por
  significado quedaba apagada en silencio.
- `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` más chico que la marca de recorte ya no produce
  episodios más largos que el tope.
- La ayuda de `mismem-embed` lista `MAX_CHARS` y `TIMEOUT_MS`, y aclara cuándo hace falta `--force`.

### La consolidación ya no descarta contenido válido como ruido

- Un resumen de más de 500 caracteres ya no invalida la memoria: el `gist` se recorta y el texto completo
  pasa a `details`. Antes la memoria se descartaba en silencio y, si era la única de la tanda, todos sus
  episodios quedaban marcados como "sin señal" y se borraban con el siguiente `forget`.
- Si el LLM devuelve alguna memoria mal formada, o un JSON sin la lista de memorias, la respuesta entera
  cuenta como inválida: la tanda se parte y se reintenta, igual que con un JSON roto.
- El error de un JSON roto ya no incluye el texto de la respuesta (terminaba en el log del cron).

### Un JSON roto de un solo episodio ya no traba el ámbito

- Si el LLM devuelve JSON inválido con un único episodio, ese episodio queda como ruido
  y la corrida sigue con el resto. Antes el ámbito entero fallaba y la próxima noche
  chocaba contra el mismo episodio.
- Si ese episodio venenoso sale, la tanda siguiente vuelve a llenarse. En
  `engram-compat` el tope se quedaba en 1 y procesaba de a uno. Si la respuesta
  se corta, el tope chico se mantiene (el modelo no entra más).

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
