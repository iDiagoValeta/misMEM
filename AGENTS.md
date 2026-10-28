# AGENTS.md

Las convenciones de este repositorio (stack, esquema, reglas de seguridad y flujo de trabajo)
son las de [`.github/copilot-instructions.md`](.github/copilot-instructions.md). Ese fichero es
la fuente única, también para Claude Code y opencode: no copies su contenido acá, porque una
copia diverge.

La comprobación antes de dar un cambio por terminado, desde `engine/`:

```bash
pnpm typecheck && pnpm test
```
