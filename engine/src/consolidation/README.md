# misMEM — Consolidación LLM (ciclo de sueño)

Destila episodios verbatim en memorias estructuradas usando un LLM: DeepSeek directo si hay
`DEEPSEEK_API_KEY`, si no OpenRouter.

## Arquitectura

```
episodes (verbatim; `forget` los borra una vez consolidados)
   ↓ runConsolidation() — diario 4 AM
memories (gist + details, salience decay/Hebbian)
   ↓ crystallize()
traits (patrones cristalizados)
```

## Comando

```bash
mismem-consolidate [--dry-run] [--scope <name>] [--min-age-hours 24] [--min-episodes 3] [--max-batch 60]
```

## Configuración

Las variables (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `MISMEM_CONSOLIDATION_*`) y sus defaults están
en la [referencia única de DEPLOY.md](../../../DEPLOY.md#variables-de-entorno-referencia-única).

## Calidad

- **Modelo**: DeepSeek V3 (`deepseek-chat`)
- **Costo acotado**: cada llamada lleva como mucho `MAX_PROMPT_CHARS` de episodios y `MAX_TOKENS` de
  respuesta, y cada corrida como mucho `MAX_CALLS` llamadas. Un atraso grande se vacía en varias noches.
- **Proveedor sin saldo o clave inválida** (HTTP 401/402/403): la corrida se corta en el primer error
  en vez de repetirlo por cada ámbito.
- **Anti-alucinación**: filtra `evidence_episode_ids` que no estén en el batch
- **Ruido**: lo que no llega a memoria queda atado a una memoria marcadora (`[noise] …` o `[pareto:l0] …`)
  con `salience=0.05`, y `forget` lo borra a los 30 días **junto con sus episodios**. Pasa en cuatro casos:
  el pre-filtro Pareto lo descartó, el LLM devolvió `memories: []`, el LLM leyó el episodio y no lo citó
  en ninguna memoria, o un episodio solo devolvió JSON inválido. Los tres últimos dependen del LLM:
  conviene mirar el log de las primeras corridas y tener respaldos que duren más que esos 30 días.
- **Respuesta mal formada**: un JSON roto, sin la lista de memorias o con alguna memoria inválida parte la
  tanda a la mitad y reintenta. Un `gist` de más de 500 caracteres se recorta y el texto completo pasa a
  `details`.
- **Lo que manda afuera**: el cuerpo de cada episodio (hasta `MAX_EPISODE_CHARS`), su id, su fecha y el
  nombre del ámbito viajan al proveedor del LLM.

## Deployment en producción (mismem-brain)

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

### 3. Cron en el servidor (4 AM diario, una hora después del respaldo)

```bash
crontab -e
# Añadir:
0 4 * * * docker exec mismem-brain node /app/dist/consolidate-cli.js >> /var/log/mismem-consolidation.log 2>&1
```

### 4. Probar manualmente primero (dry-run)

```bash
ssh <tu-servidor> "docker exec mismem-brain node /app/dist/consolidate-cli.js --dry-run"
```

Después una corrida real con un solo scope:
```bash
ssh <tu-servidor> "docker exec mismem-brain node /app/dist/consolidate-cli.js --scope engram-compat --max-batch 10"
```

## Tests

```bash
pnpm test consolidation
```

Cubren: skip por threshold, skip por edad, destilación exitosa, stub para noise, anti-alucinación,
dry-run, corte ante error fatal, tandas dentro del presupuesto, recorte de episodios enormes, tope de
llamadas, y elección de proveedor y tope de tokens (`consolidation-llm.test.ts`).
