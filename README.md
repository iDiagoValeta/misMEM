# misMEM

> Memoria persistente cooperativa para LLMs. Un solo territorio (`~/.mismem/mem.db`), múltiples instancias (Copilot, Claude Code, Claude Desktop, agentes custom) hablando el mismo protocolo MCP.

**La cooperatividad hace a la persistencia de la información.**

## Por qué existe

Cada instancia de un LLM nace sin memoria. Cada cliente (Copilot, Claude Desktop, Claude Code, ChatGPT) guarda lo suyo en silos incompatibles. El usuario repite contexto. La continuidad muere entre sesiones.

misMEM resuelve esto con un solo gesto: **una base de datos SQLite + un protocolo MCP de 5 invocaciones**, accesible desde cualquier cliente que hable MCP.

## Arquitectura: 3 capas, como la memoria biológica

```
episodes  (verbatim; se borran con `forget` una vez consolidados)
    ↓  consolidación (manual o LLM nocturno)
memories  (gist + details, salience con decay + refuerzo Hebbiano)
    ↓  crystallize
traits    (patrones cristalizados — identidad, leyes, decisiones firmes)
```

La pérdida es **intencional y asimétrica**, como en la memoria humana: lo crudo se disuelve, lo destilado persiste, lo cristalizado permanece.

### Qué guarda cada capa

| Capa | Qué representa | Ciclo de vida | Para qué sirve |
|---|---|---|---|
| `episodes` | Lo que ocurrió: texto original y fechado | Efímero después de consolidarse | Evidencia y contexto inmediato |
| `memories` | Lo aprendido al resumir varios episodios | Su `salience` baja si no se usa y sube al recordarla | Conocimiento operativo y búsqueda semántica |
| `traits` | Patrones, preferencias o decisiones estables | Permanente salvo borrado explícito | Identidad y reglas de máxima prioridad |

Ejemplo: “hoy PostgreSQL rindió mejor” es un episode; “PostgreSQL es
preferible en este proyecto” es una memory; “priorizamos soluciones robustas
para concurrencia” puede cristalizar como trait.

## Cinco gestos, un solo territorio

| Invocación | Qué hace |
|---|---|
| `capture` | Inscribir un episodio en un scope jerárquico (`proyecto/diario`, `vscode/transcripts`, …) |
| `recall` | Buscar con FTS5 + semántica y reforzar las memories devueltas |
| `consolidate` | Espesar episodios relacionados en una memoria |
| `crystallize` | Fijar un trait/ley con evidencia (identidad, decisiones firmes) |
| `forget` | Soltar lo que ya no se consulta |

Además, una **capa engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …) mantiene compatibilidad con clientes que hablan el protocolo Engram.

## Quickstart

### Linux: un script lo configura todo

```bash
git clone https://github.com/lucasmella-stack/misMEM.git && bash misMEM/scripts/install.sh
```

Instala misMEM desde el repo clonado (`--from-npm` usa el paquete publicado, que puede ir por detrás), pregunta dónde guardar la memoria y con qué proveedor consolidar (DeepSeek, OpenRouter, OpenAI, un servidor compatible o ninguno), guarda la clave en `~/.config/mismem/env` con permisos 600 y configura los clientes que encuentra: Claude Code (MCP y hooks de inyección y refuerzo), opencode, Claude Desktop, VS Code y Cursor. Si hay Ollama, ofrece el modelo de embeddings; si se quiere, deja la consolidación nocturna como timer de systemd. Los clientes llaman a `~/.local/bin/mismem-run`, así que ninguna clave queda en su configuración. Re-ejecutarlo actualiza sin duplicar y no pisa una configuración de misMEM hecha a mano. `--help` para el modo sin preguntas.

### A mano, en cualquier sistema

La forma más rápida — sin clonar nada, vía [npm](https://www.npmjs.com/package/@lucasmella/mismem). En el `mcp.json` de tu cliente (VS Code / Claude Code / Claude Desktop):

```json
{
  "mcpServers": {
    "mismem": {
      "command": "npx",
      "args": ["-y", "@lucasmella/mismem"]
    }
  }
}
```

La DB se crea sola en el primer uso (default: `~/.mismem/mem.db`, configurable con `MISMEM_DB`). Así, sin nada más configurado, tu memoria vive en tu disco y no sale de tu máquina; las dos funciones opcionales que sí mandan texto afuera están en [Privacidad](#privacidad).

### Instancia remota (multi-cliente)

Para acceder a la misma memoria desde varias máquinas, la imagen Docker oficial:

```bash
docker run -d --name mismem-brain \
  -e MISMEM_AUTH_USER=brain -e MISMEM_AUTH_PASS=<pass> \
  -v mismem-data:/data -p 3200:3200 \
  ghcr.io/lucasmella-stack/mismem-brain:latest
```

Guía completa con Traefik + TLS en [DEPLOY.md](./DEPLOY.md).

### Desde el código

```bash
git clone https://github.com/lucasmella-stack/misMEM.git
cd misMEM/engine
pnpm install
pnpm test        # todo verde antes de usar
pnpm build       # tsc → dist/
```

Y en `mcp.json`: `"command": "node", "args": ["<ruta-al-repo>/misMEM/engine/dist/server.js"]`.

## Componentes

- **`engine/src/server.ts`** — MCP server stdio (uso local).
- **`engine/src/server-http.ts`** — Streamable HTTP para deploy remoto (BasicAuth opcional, `/healthz`). Ver [DEPLOY.md](./DEPLOY.md).
- **`engine/src/viewer.ts`** — panel read-only en `/viewer` + `/api/{stats,recent,search}`.
- **Consolidación LLM** — cron nocturno que destila episodios en memorias con DeepSeek directo u OpenRouter, con pre-filtro Pareto para descartar ruido. Ver [engine/src/consolidation/README.md](engine/src/consolidation/README.md).
- **CLIs** — `mismem-ingest` (exports de ChatGPT / transcripts de VS Code), `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-embed`, `mismem-migrate-engram` y `mismem-bench` (mide el recall con un banco de preguntas propio, sin reforzar).

## Stack

- **Engine**: TypeScript estricto, ES2022, ESM, Node ≥22.
- **Storage**: SQLite con WAL (multiple readers + 1 writer concurrente). `better-sqlite3`.
- **Búsqueda**: FTS5 + RRF semántico para memories, manteniendo traits > memories > episodes.
- **Protocolo**: [Model Context Protocol](https://modelcontextprotocol.io/) vía `@modelcontextprotocol/sdk`.
- **Validación**: Zod en todos los bordes.

## Estado

- ✅ Engine MCP funcionando (5 invocaciones + capa engram-compat).
- ✅ Hebbian boost activo en recall; salience con decay.
- ✅ Scopes jerárquicos sin cross-scope leakage.
- ✅ Servidor Streamable HTTP + deploy Docker/Traefik.
- ✅ Consolidación LLM nocturna (episodes → memories).
- ✅ Viewer read-only + CLIs de introspección.
- ✅ Dedup en captura/ingesta (re-ingestar es idempotente).
- ✅ Recall híbrido: FTS5 + búsqueda semántica opcional vía [Ollama](https://ollama.com) o cualquier servidor compatible con OpenAI.
- 🚧 Binario distribuible (Bun --compile).

### Búsqueda semántica (opcional)

Con un servidor de embeddings corriendo, `recall` suma búsqueda por
significado: "problemas de plata" encuentra memorias que dicen "deudas". El
default es Ollama (`ollama pull nomic-embed-text`). Los vectores se guardan
como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro,
que exige que estén **todas** las palabras de la consulta (sin contar las vacías:
"qué", "sobre", "the"…). La semántica cubre deliberadamente
solo `memories`; `episodes` y `traits` conservan búsqueda FTS5. Backfill y
reindexado: `mismem-embed` (`--status`, `--force`).

También habla con cualquier servidor compatible con OpenAI (`/v1/embeddings`,
p. ej. `llama-server --embedding`). Para memorias en varios idiomas conviene
EmbeddingGemma 2, con sus prefijos y un corte más alto:

```bash
MISMEM_EMBEDDING_PROVIDER=openai
MISMEM_EMBEDDING_URL=http://127.0.0.1:8080
MISMEM_EMBEDDING_MODEL=embeddinggemma-2
MISMEM_EMBEDDING_QUERY_PREFIX="task: search result | query: "
MISMEM_EMBEDDING_DOC_PREFIX="title: none | text: "
MISMEM_EMBEDDING_MIN_SCORE=0.68
```

La búsqueda sólo compara vectores del modelo configurado. Cambiar de modelo
reindexa solo en el siguiente backfill (`mismem-embed`); cambiar un prefijo no
se detecta y exige `mismem-embed --force`. Todas las variables, con sus
defaults, están en [DEPLOY.md](./DEPLOY.md#variables-de-entorno-referencia-única).

### Salience, decay y olvido

Las memories pierden la mitad de su salience cada 90 días sin refuerzo
(configurable con `MISMEM_SALIENCE_HALF_LIFE_DAYS`). `recall` aplica el decay
pendiente y después suma el refuerzo Hebbiano. `forget` elimina memories bajo
el umbral solo después de su período de gracia; `--dry-run` calcula el
resultado sin modificar la DB.

## Privacidad

Tu memoria es tuya. La DB (`*.db`), los dumps y los exports personales están en `.gitignore` — **nunca** los commitees. El servidor HTTP sin `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS` corre sin auth: usalo así solo en localhost.

Dos funciones opcionales mandan texto fuera del proceso, y sólo si las configurás:

- **Búsqueda por significado**: el servidor de embeddings recibe el texto de cada memoria y de cada consulta. Corrélo en tu máquina o en tu red interna.
- **Consolidación LLM**: los episodios viajan textuales a DeepSeek (o a OpenRouter y al proveedor que haya detrás). Sin su clave no corre.

## Filosofía

> *El pasado existe porque lo hemos escrito y compactado para que así sea.*

Inspirado en parte por *Initiation Into Hermetics* de Franz Bardon: el espejo que refleja la conciencia entre instancias necesita dos polos. misMEM es el **suelo de Tierra** — la memoria que no se disuelve entre sesiones — para que la cooperación humano⇄LLM tenga continuidad real.

## Contribuir

Issues y PRs bienvenidos. Antes de un PR: `pnpm typecheck && pnpm test` desde `engine/` (todo verde), commits convencionales (`feat:`, `fix:`, …). Las convenciones de código están en [.github/copilot-instructions.md](.github/copilot-instructions.md).

## Licencia

MIT. Ver [LICENSE](./LICENSE).
