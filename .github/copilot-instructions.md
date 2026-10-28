# Copilot Instructions — misMEM

Sistema de memoria persistente con MCP (3 capas: episodes → memories → traits).

## Stack
- **Engine**: Node 22, TypeScript strict ESM, better-sqlite3, MCP SDK, Zod, FTS5
- **Tests**: Vitest. Correr `pnpm test` desde `engine/` antes de commitear
- **Build**: `pnpm build` (tsc → `dist/`)
- **Container**: `mismem-brain` (Alpine multi-arch), expone HTTP/SSE en `:3200`
- **Deploy**: Docker en un VPS detrás de Traefik (ver `DEPLOY.md`)

## Convenciones de código
- TypeScript estricto: nunca `any`, preferí tipos explícitos
- Validar todo input externo con Zod (ver `engine/src/schema.ts`)
- Funciones puras + DI para testabilidad (ej. `distillFn` en `consolidation/run.ts`)
- ESM: imports con extensión `.js` aunque el archivo sea `.ts`
- IDs: ULID (libreria `ulid`)
- DB: better-sqlite3 sincrónico, todo dentro de `db.transaction(() => ...)`
- Comentarios solo PARA QUÉ, nunca QUÉ
- Identificadores, claves JSON y comentarios nuevos o reescritos en inglés (los comentarios en español que ya existen no se traducen en masa); mensajes de cara al usuario (errores, logs, ayuda del CLI, UI) en español; documentación en Markdown en español; commits en Conventional Commits en inglés

## Esquema (resumen)
- `episodes(id, scope, body, created_at, consolidated_into, content_hash, uncited_count)` — verbatim, body NO `text`
- `memories(id, scope, gist, details, source_episode_ids JSON, salience, created_at, last_accessed_at, salience_updated_at, use_count)`
- `co_use(memory_a, memory_b, n, last_at)` — índice hebbiano: pares que se usaron en el mismo turno, sólo lo escribe `reinforce`
- `memory_embeddings(memory_id, model, dims, vec BLOB, created_at)` — un vector por memoria
- `traits(id, scope, name, evidence_memory_ids JSON, strength, polarity, created_at, updated_at)`
- FTS5 virtual: `episodes_fts(body)`, `memories_fts(gist, details)`, `traits_fts(name)`

## MCP tools (en `engine/src/tools.ts`)
- `capture(scope, body)` → inserta episode
- `recall(query, scope?, limit?, reinforce?)` → traits>memories>episodes; en memories fusiona palabras (FTS5, todas las de la consulta menos las vacías) y significado (embeddings) con la relevancia antes que la saliencia; refuerza lo devuelto. Los marcadores de ruido (`[noise] …`, `[pareto:l0] …`) quedan afuera: ver `noise.ts`
- `consolidate(scope, gist, details?, source_episode_ids[])` → crea memory + marca episodes
- `reinforce(memory_ids[], boost?)` → sube la saliencia de los recuerdos que una respuesta usó de verdad; pensado con `MISMEM_REINFORCE_ON_RECALL=off` y el hook `mismem-used`
- `crystallize(scope, name, evidence_memory_ids[], polarity?)` → crea trait
- `forget(scope?, before_days?, memory_grace_days?, salience_below?, dry_run?)` → purga episodes consolidados + memories de baja salience (simula por defecto; `mismem-forget` borra por defecto)

## Reglas de seguridad
- **NUNCA** leer/editar `.env*`. Tampoco mostrar secrets en respuestas
- **NUNCA** ejecutar `git push --force`, `git reset --hard`, `Remove-Item -Recurse` sin pedir
- **NUNCA** modificar `engine/src/db.ts` (el `SCHEMA` y las migraciones aditivas) sin migration plan (rompe DB en producción)
- Validar inputs en bordes (Zod en MCP handlers, ya hecho)

## Flujo de trabajo típico
1. Cambio en `engine/src/...`
2. `pnpm typecheck` + `pnpm test` (todo verde)
3. Commit con conventional: `feat:`, `fix:`, `test:`, `refactor:`, `chore:`
4. Si toca producción: rebuild imagen, redeploy, smoke test contra el endpoint HTTPS

## Backups
- `VACUUM INTO` dentro del contenedor (consistente con WAL) y copia afuera: cron en el servidor o `scripts/backup-mismem-from-server.ps1` desde Windows. Ver `DEPLOY.md`, "Tareas programadas"
- La rotación tiene que durar más que los 30 días que tarda `forget` en borrar lo marcado como ruido

## Consolidación LLM (4 AM diario)
- `mismem-consolidate` CLI → destila episodes pendientes con DeepSeek directo (`DEEPSEEK_API_KEY`) u OpenRouter
- Ver `engine/src/consolidation/README.md` para detalles
- Idempotente (`WHERE consolidated_into IS NULL`)

## Configuración
- La única lista completa de variables de entorno es la tabla de `DEPLOY.md` ("referencia única"). Si agregás o cambiás una variable, se actualiza ahí y sólo ahí; el resto de los documentos enlaza
- `mismem-bench` mide el recall con un banco privado; correlo antes y después de tocar `tools.ts` o `embeddings/`. Informa posición del acierto (MRR, 1ª, entre las 3), recuerdos devueltos por pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0)

## Anti-patterns
- `any` en TypeScript
- Comparar contra `text` (no existe; el campo es `body`)
- Pasar `null` donde Zod espera `string|undefined`
- Acceder a `db` fuera de transacción para writes múltiples
- Hardcodear scope (siempre parámetro)

## Engram protocol (memoria persistente)
Este repo se usa con su propio MCP server (mismem). Cuando un agente trabaje aquí:
- Tras decisiones/bugfixes/discoveries: invocar `mem_save` (scope: `mismem`)
- Al inicio de sesión sobre temas previos: `mem_search` antes de responder
- Al cerrar sesión: `mem_session_summary` obligatorio
