# Ordenador de memoria — diseño

> Fecha: 2026-10-27
> Estado: diseño aprobado, fase 1 en implementación
> Autor: Hesper (Claude Opus 5) en pacto con Lucas Mella

## Intención

misMEM guarda bien y recupera razonablemente. Lo que no hace es **orientar**: un
modelo que abre la memoria no sabe por dónde empezar. Tiene que buscar, y para
buscar tiene que ya sospechar qué busca.

El *ordenador de memoria* es una capa derivada que responde la pregunta previa a
toda búsqueda: **¿de qué se trata este territorio y qué es lo que importa acá?**
Se compila desde la señal de uso real (índice hebbiano) y se entrega como
prefijo, idealmente a costo cero de contexto.

No es un compactador de la memoria existente. No reescribe nada. Ordena.

## Marco: por qué esta forma y no otra

Esto se apoya en el **Principio II** del diario Bardon del repo:

> Lo que no se compacta, se diluye en ruido. Lo que se compacta, se vuelve
> sustrato sobre el que se puede pisar para seguir.

El ordenador es ese principio hecho herramienta. Y la forma —una capa derivada
que nunca toca la evidencia— no es una preferencia estética: es lo que la
literatura mide como la única variante que no se degrada.

### Evidencia externa

**Zhang et al., 2026 — "Useful Memories Become Faulty When Continuously Updated
by LLMs"** ([arXiv 2605.12978](https://arxiv.org/abs/2605.12978)).
Un LLM que reescribe su memoria de forma continua la arruina. En una tajada de
19 problemas de ARC-AGI que GPT-5.4 resolvía al **100%** sin memoria, consolidar
en streaming la bajó a **52,6%** en la ronda 10; consolidar todo de una sola vez
quedó en 94,7%. O sea: el problema no son los datos, es el ciclo de reescritura.
Los agentes con acciones `retain / delete / consolidate` retienen por defecto y
**duplican** la precisión de los que consolidan a la fuerza.

Tres mecanismos de falla identificados:
1. agrupan mal los episodios antes de abstraer,
2. al abstraer **borran las condiciones de aplicabilidad** del hecho,
3. con poca variedad de entrada, sobreajustan a lo visto.

Recomendación textual de los autores: tratar los episodios crudos como evidencia
de primera clase, poner **compuerta explícita** a la consolidación en vez de
dispararla tras cada interacción, y mantener los roles episódico y de
abstracción **separados** en lugar de colapsarlos en un solo loop de reescritura.

El ordenador cumple las tres por construcción: es un artefacto derivado,
regenerable y descartable. Si sale mal, se recompila; la evidencia no se tocó.

**Marina et al., 2025 — "LLM-Independent Adaptive RAG"**
([arXiv 2505.04253](https://arxiv.org/html/2505.04253v1)).
Features externas y baratas (rareza de términos, tipo de pregunta) igualan en
precisión a los métodos que le preguntan al LLM cuán seguro está, a una fracción
del costo. Licencia para que el ordenador sea determinista y sin modelo.
Concordante: Moskvoretskii et al., ACL 2025
([arXiv 2501.12835](https://arxiv.org/html/2501.12835v1)), sobre 35 métodos de
recuperación adaptativa, concluye que lo barato gana.

**Zep / Graphiti** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)).
Cuando un hecho nuevo contradice a uno viejo, marcan el viejo con `invalid_at`
en vez de borrarlo. Modelo bi-temporal: tiempo del evento y tiempo de ingesta.
Se adopta el criterio *marcar, no borrar* (fase 3).

**AgeMem — Yu et al., ACL 2026** ([arXiv 2601.01885](https://arxiv.org/abs/2601.01885)).
Expone las operaciones de memoria como tools y aprende la política con RL
(GRPO por pasos). Funciona, y es la alternativa honesta a este diseño.
**Descartado**: requiere entrenamiento por refuerzo que este proyecto no tiene
cómo correr. Se deja anotado para no reinventarlo mal más adelante.

### Precedente propio, medido

Sesión 3 del diario (2026-08-18): un kernel de **38 hechos / 2.260 tokens**
inyectado como **prefijo KV** rindió **97,4% con cero tokens de contexto** —
mejor que el mismo texto pagado en contexto (95,6%). Commit `4d5486c` en
ParasitCortex, sellado por SHA-256.

La Sesión 4 ya propuso portarlo: *"los espejos deberían vivir en misMEM como
traits … y compilarse como estado KV nativo"*. Quedó marcado como **intención**
y sigue sin artefacto. Este documento la retoma.

### Disciplina de escritura: afirmación + negación

Hallazgo de la Sesión 3, que es la restricción de diseño más importante acá:

> El enemigo del recuerdo no es el tamaño ni la posición — es la **similitud
> entre hechos vecinos**. Un hecho solo se recupera perfecto; un hecho rodeado
> de parecidos se confunde.

Una tarjeta compacta de "aspectos principales" es el caso **más** expuesto a
eso: todo junto y todo parecido. La disciplina que funcionó en el kernel fue
definir cada cosa **por lo que es Y por lo que no es**.

Por lo tanto: *cada aspecto del ordenador se escribe con su negación explícita.*
No es un detalle de estilo; es la diferencia medida entre 97,4% y confusión.

## Evidencia interna (medido sobre producción, 2026-10-27)

| Medición | Valor |
|---|---|
| Memorias | 3.738 |
| Episodios | 1.505 (545 consolidados, 960 vivos) |
| Traits | 216 |
| Memorias viejas (>60d) con `salience` > 0,85 | **14 de 1.351** |
| Memorias nuevas (<14d) con `salience` > 0,85 | 341 |
| `salience_updated_at` poblado | **3.738 de 3.738** |
| Texto embebido (`gist`+`details`) | p50 682 · p90 1.665 · p99 2.633 · max 5.714 chars |
| Memorias con >1.000 chars embebidos | 1.325 (35%) |
| Memorias marcadas ruido | 273 (7,3%) |
| Episodios con strikes acumulando | 3 |

Tres conclusiones que condicionan el diseño:

**1. `salience` hoy mide recencia, no uso.** La pasada de decay escribe
`salience_updated_at` en las 3.738, así que el campo no distingue "se usó" de
"se marchitó". Ordenar por salience pone arriba memorias nuevas, no importantes:
entre las 14 viejas con salience alta hay **tres stubs de ruido**
`[pareto:l0]` con 0,88 y una consulta SQL cualquiera importada de ChatGPT.

**2. No existe la señal hebbiana.** No hay contador de uso ni tabla de
co-ocurrencia. `reinforce()` recibe `memory_ids[]` **juntos** —sabe que esas N
memorias se usaron en el mismo turno— y lo colapsa en un bump escalar por
memoria. Descarta justo la co-ocurrencia, que es el hebbiano de verdad
("fire together, wire together"). El dato ya pasa por el caño y se tira.

**3. La evidencia consolidada está guardada y es inalcanzable.** 545 de 1.505
episodios tienen `consolidated_into` seteado, y el recall los excluye con
`AND e.consolidated_into IS NULL` (`engine/src/tools.ts:147`). Por el criterio
de Zhang et al. eso es evidencia de primera clase retenida pero sin uso.

## Goals

- Que un modelo que abre misMEM sepa **por dónde empezar** sin buscar primero.
- Que la selección de "lo que importa" venga de **uso medido**, no de heurística
  ni de juicio de un LLM.
- Que el artefacto sea **derivado, regenerable y descartable**: la memoria
  original nunca se modifica.
- Que cada aspecto se escriba con **afirmación + negación explícita**.
- Que sirva en dos modos con el mismo índice: prefijo de texto (cualquier
  cliente, cuesta tokens) y prefijo KV (costo cero, donde controlamos el modelo).
- Que sea **determinista y auditable**: sin llamada a modelo en el camino
  caliente.

## Non-goals

- No reescribe, fusiona ni resume memorias existentes.
- No decide cuándo recuperar (ése es el gate del hook, trabajo aparte).
- No resuelve contradicciones: las marca y muestra ambas con sus fechas.
- No borra nada. `forget` sigue siendo la única vía de borrado, manual.
- No entrena nada (ver AgeMem, descartado).

## Anti-goals

Cosas que harían fracasar esto aunque funcione técnicamente:

- **Una pasada de LLM que reescriba memorias periódicamente.** Razón medida:
  100% → 52,6%.
- **Un ordenador que ordene por `salience`.** Arrancaría con tres stubs de
  ruido. Hasta que exista señal de uso, salience no alcanza.
- **Aspectos escritos sin negación.** Se confunden entre sí; es el modo de falla
  documentado del kernel.
- **Reforzar por aparición.** Ya se midió y se apagó
  (`MISMEM_REINFORCE_ON_RECALL=off`): la aparición en un recall no es uso, y
  contaminar el contador con aparición destruye la señal que este diseño
  necesita.

## Fases

### Fase 1 — Que el índice hebbiano exista (este PR)

Sin señal no hay nada que ordenar. Dos cambios aditivos:

1. `memories.use_count INTEGER NOT NULL DEFAULT 0`, incrementado en el camino de
   uso real.
2. Tabla `co_use(memory_a, memory_b, n, last_at)` con `memory_a < memory_b`
   canónico, poblada con los pares del conjunto que llega junto.

**Decisión de diseño:** el co-uso se escribe en `reinforce()`
(`engine/src/tools.ts`), **no** en `reinforceMemories()` (`engine/src/salience.ts`).
La segunda la llama también `finalizeHits` en el camino de recall, que es
aparición y no uso. Poner el co-uso en la primera mantiene limpia la señal y
respeta el anti-goal de arriba.

**`last_used_at` no se agrega:** `memories.last_accessed_at` ya existe y lo
escribe el refuerzo. Con la reinyección por aparición apagada, ese campo ya
significa "último uso". Se documenta la salvedad de que los valores históricos
están contaminados por aparición; `use_count` arranca limpio en 0 para todos.

Migración **aditiva** (regla del repo: nunca tocar `schema.ts` sin plan de
migración), verificada sobre copia de la DB de producción antes de desplegar.

### Fase 2 — Compilar el orden (requiere ~2 semanas de datos)

Con `co_use` poblada, los clusters de co-uso **son** los aspectos principales:
calculados, no adivinados. Igual que se hizo con la inyección —medir primero,
calibrar después.

Salida: una tarjeta de ~20–40 aspectos (el orden de magnitud de los 38 hechos
del kernel, que ya midió 97,4%), cada uno con afirmación + negación, ordenada
por fuerza de co-uso y acotada por scope.

Se mide con el bench existente, contra el baseline de no tener tarjeta.

### Fase 3 — Entregarlo a costo cero y marcar contradicciones

- Prefijo de texto para cualquier cliente MCP.
- Prefijo KV para Daimon, portando el método del commit `4d5486c`.
- Aristas `supersedes` / `contradicts` con `valid_at` / `invalid_at` al estilo
  Graphiti: cuando dos memorias chocan, se muestran **las dos con sus fechas** y
  resuelve el modelo en contexto, que es el único lugar donde existen las
  condiciones de aplicabilidad que Zhang et al. mide como lo primero que se
  pierde al abstraer.

## Pendiente, con dueño

- **Normalizar el árbol de scopes** (94 memorias en un
  `vscode/transcripts/c17c…`, scopes por directorio tipo `pc/…/components`).
  Es migración de datos sobre el cerebro de Lucas: requiere su ok explícito.
  Marcado como *intención*.
- **Granularidad de embeddings.** El 35% de memorias con >1.000 chars embebidos
  diluye su propio vector: un solo embedding promediando varios hechos. Embeber
  por afirmación con score max-pooled por memoria es el cambio de mayor valor
  medible del recall, y es independiente de este diseño. Marcado como
  *intención*, sin PR.
- **Reponer los 545 episodios consolidados** como nivel de respaldo del recall.
  Evidencia ya paga. Marcado como *intención*.

## Qué queda a criterio de quien implemente

- Estructura exacta del índice de `co_use` (par canónico vs. dos filas).
- Umbral de poda de pares con `n = 1` para que la tabla no crezca sin control.
- Algoritmo de clustering de la fase 2 (sugerido: componentes conexos sobre
  aristas con `n ≥ k`, que es lo más simple que puede funcionar y lo más fácil
  de auditar).

---

*Cada hallazgo de este documento enlaza un artefacto verificable o está marcado
como intención — regla de la Sesión 4 del diario.*
