# misMEM — Despliegue en producción

Guía para correr `mismem-brain` (el servidor MCP HTTP de misMEM) en un VPS con
Docker detrás de Traefik. Reemplazá `mem.example.com` por tu dominio.

---

## Arquitectura

```
Cliente MCP (VS Code / Claude Code / Claude Desktop / agente)
        │  HTTPS + BasicAuth
        ▼
   Traefik (TLS via ACME)
        │
        ▼
 mismem-brain :3200  ──  SQLite en volumen `mismem-data`
        │
        ├──▶ servidor de embeddings (opcional, red interna): Ollama o llama-server
        └──▶ LLM de consolidación (opcional, sale a internet): DeepSeek u OpenRouter
```

- Transporte: **Streamable HTTP** (stateless: server+transport por request).
- Auth: BasicAuth (en Traefik como middleware, o nativa del server vía
  `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS`). **Sin ninguna de las dos el servidor
  queda abierto**: `/mcp`, el visor y `/api/*` responden a cualquiera que llegue
  al puerto, incluidos los otros contenedores de la misma red.
- Qué sale del servidor: nada, salvo que actives la consolidación. Ahí los
  episodios viajan textuales al proveedor del LLM (ver [Privacidad](#privacidad)).

---

## Pre-requisitos

- [ ] VPS con Docker + Docker Compose y Traefik ya funcionando (ACME configurado)
- [ ] DNS: A record de `mem.example.com` → IP del servidor
- [ ] Build local OK (`pnpm build`, `pnpm test`)

---

## Fase 1 — Obtener la imagen

Opción A — imagen oficial multi-arch desde GHCR (recomendada):

```bash
docker pull ghcr.io/lucasmella-stack/mismem-brain:latest
```

Opción B — build en el servidor (arquitectura nativa):

```bash
ssh <tu-servidor>
git clone https://github.com/lucasmella-stack/misMEM.git mismem
cd mismem/engine
docker build -t mismem-brain:latest -f Dockerfile.mismem-brain .
```

---

## Fase 2 — Servicio en `docker-compose.yml`

```yaml
  mismem-brain:
    image: ghcr.io/lucasmella-stack/mismem-brain:latest
    container_name: mismem-brain
    restart: unless-stopped
    environment:
      MISMEM_HTTP_PORT: 3200
      MISMEM_HTTP_HOST: 0.0.0.0
      MISMEM_DB: /data/mem.db
      MISMEM_AUTH_USER: ${MISMEM_BRAIN_USER}
      MISMEM_AUTH_PASS: ${MISMEM_BRAIN_PASS}
    volumes:
      - mismem-data:/data
    networks:
      - traefik-network
    labels:
      traefik.enable: "true"
      traefik.docker.network: "traefik-network"
      traefik.http.routers.mismem.rule: "Host(`mem.example.com`)"
      traefik.http.routers.mismem.entrypoints: "websecure"
      traefik.http.routers.mismem.tls.certresolver: "le"
      traefik.http.services.mismem.loadbalancer.server.port: "3200"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3200/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  mismem-data:
```

Y en el `.env` del compose (NUNCA en git):

```env
MISMEM_BRAIN_USER=brain
MISMEM_BRAIN_PASS=<generar con: openssl rand -hex 24>
```

Levantar y validar:

```bash
docker compose up -d mismem-brain
docker logs -f mismem-brain     # esperar "misMEM HTTP listening on …"

curl -s https://mem.example.com/healthz
# {"status":"ok","service":"mismem"}

curl -s -u brain:$MISMEM_BRAIN_PASS https://mem.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

> Recomendado: añadir un middleware de rate-limit en Traefik
> (`ratelimit.average=10`, `burst=30`, `period=1s`).

### Búsqueda por significado (opcional)

Sin servidor de embeddings, `recall` busca sólo por palabras. Para sumar
significado hace falta uno en la misma red interna, **sin** exponerlo por
Traefik (no tiene auth). Con [llama.cpp](https://github.com/ggml-org/llama.cpp)
y EmbeddingGemma 2, que cruza idiomas:

```yaml
  mismem-embed:
    image: ghcr.io/ggml-org/llama.cpp:server   # fijá el digest que probaste
    container_name: mismem-embed
    restart: unless-stopped
    command: ["-m", "/models/embeddinggemma-2-Q8_0.gguf", "--embedding",
              "--host", "0.0.0.0", "--port", "8080", "-t", "2",
              "-c", "2048", "-b", "2048", "-ub", "2048"]
    volumes:
      - ./models:/models:ro
    networks:
      - internal
    deploy:
      resources:
        limits:
          memory: 2048M
```

Y en `mismem-brain` (sumándolo a la red `internal`):

```yaml
      MISMEM_EMBEDDING_PROVIDER: openai
      MISMEM_EMBEDDING_URL: http://mismem-embed:8080
      MISMEM_EMBEDDING_MODEL: embeddinggemma-2
      MISMEM_EMBEDDING_QUERY_PREFIX: "task: search result | query: "
      MISMEM_EMBEDDING_DOC_PREFIX: "title: none | text: "
      MISMEM_EMBEDDING_MIN_SCORE: "0.68"
```

El modelo (310 MB) se baja una vez de
[ggml-org/embeddinggemma-2-GGUF](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF).
Con el límite de 2 GB el contenedor queda pegado al tope: vigilalo con
`docker stats`. Después de levantarlo, o de sembrar una DB que traía vectores
de otro modelo, hay que indexar:

```bash
docker exec mismem-brain node dist/embed-cli.js --status   # cuántas memorias tienen vector del modelo activo
docker exec mismem-brain node dist/embed-cli.js            # completa las que faltan
```

Cambiar de **modelo** se detecta solo. Cambiar un **prefijo** o
`MISMEM_EMBEDDING_MAX_CHARS` no: los vectores viejos siguen contando como
válidos, así que hay que reindexar todo con `--force`. Mientras dura el
reindexado, la búsqueda por significado sólo ve las memorias ya procesadas.

---

## Fase 3 — Sembrar la DB (opcional)

Si querés llevar tu memoria local al servidor:

```bash
scp ~/.mismem/mem.db <tu-servidor>:/tmp/mem.db
ssh <tu-servidor>
docker stop mismem-brain
docker run --rm -v mismem-data:/data -v /tmp:/in alpine \
  sh -c "cp /in/mem.db /data/mem.db && chown 1000:1000 /data/mem.db"
docker start mismem-brain
docker logs --tail 20 mismem-brain
```

Alternativa: exportar desde otra fuente a JSONL e ingestar con
`node dist/ingest-cli.js` (soporta exports de ChatGPT y transcripts de VS Code).

---

## Fase 4 — Conectar clientes

### VS Code / Claude Code (`mcp.json`)

```json
"mismem": {
  "type": "http",
  "url": "https://mem.example.com/mcp",
  "headers": {
    "Authorization": "Basic <base64(user:pass)>"
  }
}
```

### Clientes que solo hablan stdio

```json
"mismem": {
  "command": "npx",
  "args": ["-y", "supergateway", "--streamableHttp",
           "https://mem.example.com/mcp",
           "--header", "Authorization: Basic <base64(user:pass)>"]
}
```

---

## Tareas programadas

Tres, en el `crontab` del servidor. El orden importa: el respaldo va antes de
todo lo que borra.

```bash
#!/bin/sh
# /usr/local/bin/mismem-backup — respaldo consistente (VACUUM INTO es seguro con WAL)
set -e
tmp=/tmp/mismem-backup.db
echo "VACUUM INTO '$tmp';" | docker exec -i mismem-brain sh -c "rm -f $tmp; sqlite3 /data/mem.db"
docker cp "mismem-brain:$tmp" "/opt/backups/mismem/mismem-$(date +%F).db"
docker exec mismem-brain rm -f "$tmp"
```

```cron
0 3 * * *  /usr/local/bin/mismem-backup
45 5 * * * find /opt/backups/mismem -name "mismem-*.db" -mtime +30 -delete
# Consolidación: episodios -> memorias (opcional, necesita la clave de un LLM)
0 4 * * *  docker exec mismem-brain node /app/dist/consolidate-cli.js >> /var/log/mismem-consolidation.log 2>&1
# Olvido: borra episodios ya consolidados y memorias de saliencia baja
30 4 * * * docker exec mismem-brain node /app/dist/forget-cli.js --before-days 90 --salience-below 0.1 >> /var/log/mismem-forget.log 2>&1
```

- **`mismem-forget` borra de verdad si no le pasás `--dry-run`** (la tool MCP
  `forget`, en cambio, simula por defecto). Probá primero con `--dry-run`.
- La consolidación marca como ruido lo que el LLM no usó, con saliencia 0,05;
  el olvido se lo lleva a los 30 días junto con sus episodios. Por eso el
  ejemplo guarda 30 días de respaldos: con menos, lo que se marcó mal ya no se
  recupera.
- Los logs del cron nombran ámbitos y los primeros caracteres de algunas
  memorias: tratalos como datos personales y rotalos (`logrotate`).
- `scripts/backup-mismem-from-server.ps1` hace el mismo respaldo desde Windows.

Detalle de la consolidación en
[engine/src/consolidation/README.md](engine/src/consolidation/README.md).

## Medir el recall

`mismem-bench` cuenta cuántas veces la memoria esperada sale entre las
devueltas, con un banco de preguntas armado desde tu propia memoria. No
refuerza, así que se puede correr contra la base viva:

```bash
docker cp banco.jsonl mismem-brain:/tmp/banco.jsonl
docker exec mismem-brain node dist/bench-cli.js --bank /tmp/banco.jsonl --db /data/mem.db
```

El banco es privado: no lo subas a ningún repo.

---

## Privacidad

- La base vive en el volumen del servidor y no sale de ahí.
- El servidor de embeddings recibe el texto de cada memoria y de cada consulta:
  por eso va en la red interna.
- **La consolidación manda episodios textuales a un tercero** (DeepSeek, u
  OpenRouter y el proveedor que haya detrás): hasta 60.000 caracteres por
  llamada, con el nombre del ámbito. Es opcional: sin `DEEPSEEK_API_KEY` ni
  `OPENROUTER_API_KEY` no corre.

---

## Variables de entorno (referencia única)

Esta tabla es la única lista completa; el resto de la documentación apunta acá.
Los defaults son los del código (`engine/src`).

**Servidor**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_DB` | `~/.mismem/mem.db` (en la imagen: `/data/mem.db`) | Ruta SQLite |
| `MISMEM_HTTP_PORT` | `3200` | Puerto HTTP |
| `MISMEM_HTTP_HOST` | `0.0.0.0` | Bind address |
| `MISMEM_AUTH_USER` / `MISMEM_AUTH_PASS` | — | BasicAuth nativa. Si falta cualquiera de las dos, **sin auth** |
| `MISMEM_SALIENCE_HALF_LIFE_DAYS` | `90` | Días en que una memoria sin uso pierde la mitad de su saliencia |

**Búsqueda por significado**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_EMBEDDINGS` | `auto` | `off` apaga la capa; con `auto`, si el servidor no responde se busca sólo por palabras |
| `MISMEM_EMBEDDING_PROVIDER` | `ollama` | `ollama` (`/api/embed`) u `openai` (`/v1/embeddings`, p. ej. llama-server) |
| `MISMEM_EMBEDDING_URL` | `http://127.0.0.1:11434` (ollama) / `http://127.0.0.1:8080` (openai) | Servidor de embeddings |
| `MISMEM_OLLAMA_URL` | — | Nombre anterior de la URL; sólo vale para `ollama` |
| `MISMEM_EMBEDDING_MODEL` | `nomic-embed-text` | Modelo. Cambiarlo reindexa solo |
| `MISMEM_EMBEDDING_QUERY_PREFIX` / `_DOC_PREFIX` | vacío | Prefijos que algunos modelos piden para consulta y documento. Cambiarlos exige `mismem-embed --force` |
| `MISMEM_EMBEDDING_MIN_SCORE` | `0.5` | Parecido mínimo (coseno) para que una memoria cuente. Depende del modelo: 0,68 para EmbeddingGemma 2; `0` trae todo |
| `MISMEM_EMBEDDING_MAX_CHARS` | `4000` | Tope del texto de cada memoria al indexar. Cambiarlo exige `--force` |
| `MISMEM_EMBEDDING_TIMEOUT_MS` | `3000` | Espera por consulta (el reindexado usa 120 s) |

**Consolidación**

| Var | Default | Descripción |
|-----|---------|-------------|
| `DEEPSEEK_API_KEY` | — | Consolida con DeepSeek directo. Gana sobre OpenRouter |
| `OPENROUTER_API_KEY` | — | Alternativa. Hace falta una de las dos (salvo `--dry-run`) |
| `MISMEM_CONSOLIDATION_MODEL` | `deepseek-chat` (OpenRouter: `deepseek/deepseek-chat`) | En DeepSeek un nombre con `/` se ignora |
| `DEEPSEEK_BASE_URL` / `OPENROUTER_BASE_URL` | las oficiales | Para un proxy o un servidor compatible |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE` | repo de misMEM / `misMEM` | Cabeceras de atribución de OpenRouter |
| `MISMEM_CONSOLIDATION_MAX_TOKENS` | `8192` | Tope de la respuesta; si se corta, la tanda se parte a la mitad |
| `MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS` | `60000` | Caracteres de episodios por llamada |
| `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` | `12000` | Un episodio más largo viaja recortado (principio y final) |
| `MISMEM_CONSOLIDATION_MAX_CALLS` | `60` | Llamadas por corrida; lo pendiente queda para la siguiente |
| `MISMEM_CONSOLIDATION_MAX_BATCH` | `60` | Episodios que se leen por tanda |
| `MISMEM_CONSOLIDATION_MIN_AGE_HOURS` | `24` | Edad mínima de un episodio para consolidarlo |
| `MISMEM_CONSOLIDATION_MIN_EPISODES` | `3` | Un ámbito con menos episodios pendientes se saltea (y queda así hasta juntar ese mínimo) |

---

## Checklist final

- [ ] DNS resuelve al servidor
- [ ] `mismem-brain` UP y `healthz` OK
- [ ] Cert TLS de Traefik emitido
- [ ] `tools/list` responde vía HTTPS con auth
- [ ] Backup diario programado y probado (restaurar uno en otra máquina)
- [ ] Si hay búsqueda por significado: `embed-cli.js --status` sin memorias faltantes
- [ ] Si hay consolidación: primera corrida con `--dry-run` y logs con rotación
