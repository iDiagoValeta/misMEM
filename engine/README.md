# misMEM — engine

Memoria persistente con consolidación biológica (3 capas) sobre SQLite + FTS5, expuesta como MCP server stdio.

## Filosofía

> "Uno no recuerda exactamente lo que pasó ayer o hace 3 años, pero sí parte de eso."

La pérdida es **intencional y asimétrica**, como la memoria humana:

- **episodes** — verbatim, efímero. Lo crudo. No vencen solos: `forget` los borra una vez consolidados (30 días por defecto en la tool MCP, 90 en `mismem-forget`).
- **memories** — destilación con `salience` que decae si no se accede. Núcleo operativo.
- **traits** — patrones cristalizados. El **Soul Mirror** de Bardon. Permanente salvo borrado explícito.

En corto: un episode conserva “lo que ocurrió”, una memory conserva “lo que
aprendimos” y un trait conserva “el patrón estable que guía decisiones”.

## Invocaciones (6)

| Invocación    | Capa de origen → destino             | Quién decide  |
| ------------- | ------------------------------------ | ------------- |
| `capture`     | → episode                            | LLM (auto)    |
| `recall`      | episode + memory + trait → respuesta | LLM (auto)    |
| `reinforce`   | marca lo que la respuesta usó        | hook o LLM    |
| `consolidate` | N episodes → 1 memory                | LLM al cierre |
| `crystallize` | N memories → 1 trait                 | LLM o usuario |
| `forget`      | episodes/memories → ∅                | usuario       |

`recall` fusiona FTS5 y semántica mediante RRF para `memories`. Por defecto
refuerza las memorias devueltas, pero con `reinforce: false` o
`MISMEM_REINFORCE_ON_RECALL=off` no lo hace, y entonces la salience sigue el uso
en vez de la aparición. La salience tiene una vida media de 90 días por defecto;
`forget` aplica el decay antes de evaluar la purga.
El viewer usa el mismo ranking sin refuerzo, por lo que es realmente read-only.

`reinforce` es además el único que escribe el índice hebbiano: `memories.use_count`
y `co_use(memory_a, memory_b, n, last_at)`, los pares de recuerdos usados en el
mismo turno.

## Scope

Un servidor por proyecto. Cada `scope` es un namespace lógico dentro del mismo .db. No hay cross-scope leakage en queries scoped.

## Dev

```bash
cd engine
pnpm install
pnpm test
pnpm build
```

## Uso vía MCP (VS Code / Claude Code)

`mcp.json`:

```json
{
  "mcpServers": {
    "mismem": {
      "command": "node",
      "args": ["<ruta-al-repo>/misMEM/engine/dist/server.js"],
      "env": { "MISMEM_DB": "<home>/.mismem/mem.db" }
    }
  }
}
```

Default DB: `~/.mismem/mem.db` (configurable con `MISMEM_DB`). Todas las variables de entorno están en [DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Roadmap

- [x] Fase 0: schema + invocaciones base + tests + MCP stdio
- [x] Fase 1: ingesta de exports (ChatGPT, transcripts VS Code) como semilla
- [x] Fase 2: servidor Streamable HTTP + capa engram-compat + deploy en VPS
- [x] Fase 3: consolidación LLM (episodes → memories, DeepSeek, OpenRouter, OpenAI o servidor compatible) + pre-filtro Pareto
- [x] Fase 4: viewer read-only (`/viewer`) + CLIs (`mismem-stats`, `mismem-forget`, `mismem-migrate-engram`)
- [x] Fase 5: dedup por content-hash + embeddings opcionales (Ollama o servidor compatible con OpenAI, coseno en JS, `mismem-embed`)
- [x] Fase 6: decay idempotente + ranking híbrido consistente + reindexado seguro
- [x] Fase 7: relevancia antes que saliencia, EmbeddingGemma 2 con prefijos y corte, `mismem-bench`
- [x] Fase 8: hooks de cliente (inyección + refuerzo por uso) e instalación de un comando
- [x] Fase 9: índice hebbiano (`use_count`, `co_use`) — fase 1 del ordenador de memoria
- [ ] Fase 10: binario empaquetado (bun --compile) + onboarding
