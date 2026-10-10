# misMEM — Consolidaci\u00f3n LLM (ciclo de sue\u00f1o)

Destila episodios verbatim en memorias estructuradas usando un LLM: DeepSeek directo si hay
`DEEPSEEK_API_KEY`, si no OpenRouter.

## Arquitectura

```
episodes (verbatim, TTL ~14d)
   ↓ runConsolidation() — diario 4 AM
memories (gist + details, salience decay/Hebbian)
   ↓ crystallize()
traits (patrones cristalizados)
```

## Comando

```bash
mismem-consolidate [--dry-run] [--scope <name>] [--min-age-hours 24] [--min-episodes 3] [--max-batch 60]
```

## Env vars

| Var | Default | Descripci\u00f3n |
|-----|---------|-------------|
| `DEEPSEEK_API_KEY` | — | Si está, consolida con DeepSeek directo (gana sobre OpenRouter) |
| `OPENROUTER_API_KEY` | — | Alternativa; hace falta una de las dos (salvo `--dry-run`) |
| `MISMEM_CONSOLIDATION_MODEL` | `deepseek-chat` / `deepseek/deepseek-chat` | En DeepSeek un nombre con `/` (de OpenRouter) se ignora |
| `MISMEM_CONSOLIDATION_MAX_TOKENS` | `8192` | Tope de la respuesta; si se corta, la tanda se parte a la mitad |
| `MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS` | `60000` | Caracteres de episodios por llamada; lo que no entra va en la tanda siguiente |
| `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` | `12000` | Un episodio más largo viaja recortado (principio y final) |
| `MISMEM_CONSOLIDATION_MAX_CALLS` | `60` | Llamadas por corrida; lo pendiente queda para la noche siguiente |
| `MISMEM_CONSOLIDATION_MIN_AGE_HOURS` | `24` | Edad m\u00ednima de episodios |
| `MISMEM_CONSOLIDATION_MIN_EPISODES` | `3` | Episodios m\u00ednimos por scope |
| `MISMEM_CONSOLIDATION_MAX_BATCH` | `60` | M\u00e1x episodios que se leen por tanda |
| `MISMEM_DB` | `~/.mismem/mem.db` | Ruta a SQLite |

## Calidad

- **Modelo**: DeepSeek V3 (`deepseek-chat`)
- **Costo acotado**: cada llamada lleva como mucho `MAX_PROMPT_CHARS` de episodios y `MAX_TOKENS` de
  respuesta, y cada corrida como mucho `MAX_CALLS` llamadas. Un atraso grande se vacía en varias noches.
- **Proveedor sin saldo o clave inválida** (HTTP 401/402/403): la corrida se corta en el primer error
  en vez de repetirlo por cada ámbito.
- **Anti-alucinaci\u00f3n**: filtra `evidence_episode_ids` que no est\u00e9n en el batch
- **Sin se\u00f1al**: si LLM devuelve `memories: []`, crea memoria stub con `salience=0.05` para que decay + `forget` limpien

## Deployment en producci\u00f3n (mismem-brain)

### 1. Build + push imagen con la CLI nueva

```bash
docker build -t mismem-brain:latest -f Dockerfile.mismem-brain .
# o el flujo CI/CD que uses
```

### 2. Inyectar la clave del LLM al servicio

Editar el `docker-compose.yml` de tu stack:

```yaml
services:
  mismem-brain:
    environment:
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
```

Y en `.env` del stack:
```
DEEPSEEK_API_KEY=sk-...
```

Recrear el container:
```bash
docker compose up -d mismem-brain
```

### 3. Cron en el servidor (4 AM diario, 1h despu\u00e9s del backup)

```bash
crontab -e
# A\u00f1adir:
0 4 * * * docker exec mismem-brain node /app/dist/consolidate-cli.js >> /var/log/mismem-consolidation.log 2>&1
```

### 4. Probar manualmente primero (dry-run)

```bash
ssh <tu-servidor> "docker exec mismem-brain node /app/dist/consolidate-cli.js --dry-run"
```

Despu\u00e9s una corrida real con un solo scope:
```bash
ssh <tu-servidor> "docker exec mismem-brain node /app/dist/consolidate-cli.js --scope engram-compat --max-batch 10"
```

## Tests

```bash
pnpm test consolidation
```

Cubren: skip por threshold, skip por edad, destilaci\u00f3n exitosa, stub para noise, anti-alucinaci\u00f3n,
dry-run, corte ante error fatal, tandas dentro del presupuesto, recorte de episodios enormes, tope de
llamadas, y elección de proveedor y tope de tokens (`consolidation-llm.test.ts`).
