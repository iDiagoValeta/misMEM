# misMEM

> Memoria persistente cooperativa para LLMs. Un solo territorio (`~/.mismem/mem.db`), múltiples instancias (Copilot, Claude Code, Claude Desktop, agentes custom) hablando el mismo protocolo MCP.

**La cooperatividad hace a la persistencia de la información.**

## Por qué existe

Cada instancia de un LLM nace sin memoria. Cada cliente (Copilot, Claude Desktop, Claude Code, ChatGPT) guarda lo suyo en silos incompatibles. El usuario repite contexto. La continuidad muere entre sesiones.

misMEM resuelve esto con un solo gesto: **una base de datos SQLite + un protocolo MCP de seis invocaciones**, accesible desde cualquier cliente que hable MCP.

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

## Seis gestos, un solo territorio

| Invocación | Qué hace |
|---|---|
| `capture` | Inscribir un episodio en un scope jerárquico (`proyecto/diario`, `vscode/transcripts`, …) |
| `recall` | Buscar con FTS5 + semántica; refuerza lo devuelto salvo `reinforce: false` o `MISMEM_REINFORCE_ON_RECALL=off` |
| `reinforce` | Marcar los recuerdos que una respuesta usó de verdad, no los que aparecieron |
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

Para acceder a la misma memoria desde varias máquinas, en Docker:

```bash
git clone https://github.com/lucasmella-stack/misMEM.git && cd misMEM/engine
docker build -t mismem-brain:latest -f Dockerfile.mismem-brain .
docker run -d --name mismem-brain \
  -e MISMEM_AUTH_USER=brain -e MISMEM_AUTH_PASS=<pass> \
  -v mismem-data:/data -p 3200:3200 \
  mismem-brain:latest
```

La imagen multi-arch publicada (`ghcr.io/lucasmella-stack/mismem-brain:latest`)
**todavía no está disponible**: el workflow que la publica falla al empujar al
registro. Mientras tanto, el build local es el camino. Guía completa con Traefik
+ TLS en [DEPLOY.md](./DEPLOY.md).

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
- **`engine/ui/`** — la interfaz (React + Vite, compilada a `dist/ui/`) que `server-http` sirve en `/viewer`: memorias por salience de hoy, rasgos, lo pendiente y de dónde sale cada recuerdo. `pnpm dev:ui` la levanta en desarrollo contra un servidor en `:3200`.
- **`engine/src/viewer.ts`**, **`viewer-api.ts`** — su API de sólo lectura: `/api/{stats,recent,search,scopes,memories,graph}` y `/api/{memory,trait}/:id`. La salience que devuelven es la efectiva, con el decay aplicado a hoy, la misma que usa el recall.
- **`engine/src/viewer-actions.ts`** — lo que la interfaz puede cambiar, sólo por POST JSON desde el propio origen: corregir una memoria, deshacer su consolidación, cristalizar y lanzar una consolidación. Olvidar una memoria (con sus episodios) o un rasgo no tiene vuelta atrás y está apagado salvo con `MISMEM_VIEWER_ALLOW_DELETE=1`; aun así va en dos pasos: el primer POST devuelve qué se perdería y un token de 60 s, y borra el segundo, el que lo trae.
- **Consolidación LLM** — cron nocturno que destila episodios en memorias con DeepSeek, OpenRouter, OpenAI o cualquier servidor compatible, con pre-filtro Pareto para descartar ruido. Ver [engine/src/consolidation/README.md](engine/src/consolidation/README.md).
- **CLIs** — `mismem-http` (el mismo servidor HTTP que `pnpm start:http`), `mismem-ingest` (exports de ChatGPT / transcripts de VS Code), `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-embed`, `mismem-migrate-engram`, `mismem-bench` (mide el recall con un banco de preguntas propio, sin reforzar), `mismem-obsidian` (escribe la memoria como bóveda de Obsidian en `<bóveda>/misMEM/`: una nota por memoria, rasgo y ámbito, enlazadas por origen y por parecido; re-exportar sólo borra las notas cuyo frontmatter sigue declarando el id del manifiesto, y se niega si la base no tiene nada que exportar o el manifiesto no se puede leer) y los dos hooks, `mismem-inject` y `mismem-used`.

## Stack

- **Engine**: TypeScript estricto, ES2022, ESM, Node ≥22.
- **Storage**: SQLite con WAL (multiple readers + 1 writer concurrente). `better-sqlite3`.
- **Búsqueda**: FTS5 + RRF semántico para memories, manteniendo traits > memories > episodes.
- **Protocolo**: [Model Context Protocol](https://modelcontextprotocol.io/) vía `@modelcontextprotocol/sdk`.
- **Validación**: Zod en todos los bordes.

## Estado

- ✅ Engine MCP funcionando (seis invocaciones + capa engram-compat).
- ✅ Salience con decay; refuerzo por aparición en `recall` o por uso real vía hook.
- ✅ Scopes jerárquicos sin cross-scope leakage.
- ✅ Servidor Streamable HTTP + deploy Docker/Traefik.
- ✅ Consolidación LLM nocturna (episodes → memories).
- ✅ Índice hebbiano: `use_count` por recuerdo y `co_use` por par usado en el mismo turno.
- ✅ Viewer con el origen de cada recuerdo y el grafo de la memoria, + CLIs de introspección.
- ✅ Dedup en captura/ingesta (re-ingestar es idempotente).
- ✅ Recall híbrido: FTS5 + búsqueda semántica opcional vía [Ollama](https://ollama.com) o cualquier servidor compatible con OpenAI.
- ✅ Hooks opcionales de cliente: adelantar recuerdos antes de responder y reforzar los que se usaron.
- 🚧 Binario distribuible (Bun --compile).

### Búsqueda semántica (opcional)

Con un servidor de embeddings corriendo, `recall` suma búsqueda por
significado: "problemas de plata" encuentra memorias que dicen "deudas". El
default es Ollama (`ollama pull nomic-embed-text`). Los vectores se guardan
como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro,
que exige que estén **todas** las palabras de la consulta (sin contar las vacías:
"qué", "sobre", "the"…). Si esa consulta estricta no devuelve nada y no hay capa
semántica, `recall` reintenta con una consulta OR y conserva sólo los candidatos
que comparten al menos dos términos informativos (con una sola palabra basta una; en consultas
largas, el 30 % de sus palabras), hasta 3 por capa. El rescate alcanza a rasgos, episodios y
memorias, y no altera una búsqueda que ya encontró algo. La semántica cubre deliberadamente
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
el umbral solo después de su período de gracia y de que todos sus episodios
superen `before_days`; `--dry-run` calcula el resultado sin modificar la DB.

### El índice hebbiano

Dos recuerdos que se usan en el mismo turno tienen algo que ver entre sí, y eso
es información que la saliencia por recuerdo no guarda. `reinforce` recibe los
ids **juntos**, así que ahora los cuenta: `memories.use_count` suma los turnos
en que cada recuerdo se usó de verdad, y `co_use(memory_a, memory_b, n, last_at)`
cuenta cada par.

Lo escribe sólo `reinforce`, nunca el camino de `recall`: aparecer en una
búsqueda no es haberse usado. Con `MISMEM_REINFORCE_ON_RECALL=off` la señal
arranca limpia. Los pares se van por cascada cuando el recuerdo se borra.

Hace falta porque `salience` mide recencia más que uso —la pasada de decay toca
todas las filas, así que ordenar por saliencia pone arriba lo nuevo, no lo
importante—. Es la primera fase del *ordenador de memoria*, una capa derivada
que compacta los aspectos principales para que el modelo sepa por dónde empezar
sin tomar contexto.

### Hooks del cliente (opcional)

Dos binarios enganchan misMEM a [Claude Code](https://claude.com/claude-code) sin que el
modelo tenga que acordarse de pedir nada:

- **`mismem-inject`** (`UserPromptSubmit`) busca con el prompt y adelanta unos pocos
  recuerdos. Busca con `reinforce: false`: lo que el usuario no pidió no es uso. Se
  mantiene dormido hasta comprobar que el servidor expone `reinforce`, así que se puede
  configurar antes de desplegar.
- **`mismem-used`** (`Stop`) mira el último turno —lo que el modelo pidió con `recall` y
  lo que la inyección le puso delante— y refuerza sólo aquello cuyas palabras distintivas
  reaparecen en la respuesta. Es una aproximación: falla hacia no reforzar.

Lo inyectado viaja en cada prompt al proveedor del modelo, así que
`MISMEM_HOOK_EXCLUDE_SCOPES` decide qué ámbitos no salen. Con
`MISMEM_REINFORCE_ON_RECALL=off`, la salience pasa a seguir el uso en vez de la aparición.
Montaje y variables en [DEPLOY.md](./DEPLOY.md).

## Privacidad

Tu memoria es tuya. La DB (`*.db`), los dumps y los exports personales están en `.gitignore` — **nunca** los commitees. El servidor HTTP sin `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS` corre sin auth: usalo así solo en localhost.

Dos funciones opcionales mandan texto fuera del proceso, y sólo si las configurás:

- **Búsqueda por significado**: el servidor de embeddings recibe el texto de cada memoria y de cada consulta. Corrélo en tu máquina o en tu red interna.
- **Consolidación LLM**: los episodios viajan textuales al proveedor que configures (DeepSeek, OpenRouter, OpenAI o cualquier servidor compatible). Sin su clave no corre, y apuntándola a un servidor en tu propia red no sale nada de ella.

## Filosofía

> *El pasado existe porque lo hemos escrito y compactado para que así sea.*

Inspirado en parte por *Initiation Into Hermetics* de Franz Bardon: el espejo que refleja la conciencia entre instancias necesita dos polos. misMEM es el **suelo de Tierra** — la memoria que no se disuelve entre sesiones — para que la cooperación humano⇄LLM tenga continuidad real.

## Contribuir

Issues y PRs bienvenidos. Antes de un PR: `pnpm typecheck && pnpm test` desde `engine/` (todo verde), commits convencionales (`feat:`, `fix:`, …). Las convenciones de código están en [AGENTS.md](AGENTS.md).

## Gracias

misMEM lo arrancó una persona sola, pero no siguió así.
[**@iDiagoValeta**](https://github.com/iDiagoValeta) colaboró en su desarrollo de forma activa como muestra de su amor y apoyo incondicional hacia el Open-Source.

## Licencia

MIT. Ver [LICENSE](./LICENSE).
