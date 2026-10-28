# Hooks del cliente

Dos binarios enganchan misMEM a [Claude Code](https://claude.com/claude-code) sin que el modelo tenga que
acordarse de pedir nada. Son opcionales; `scripts/install.sh` los configura si se le pide.

| Hook | Evento | Qué hace |
|---|---|---|
| `mismem-inject` | `UserPromptSubmit` | Busca con el prompt y adelanta unos pocos recuerdos. Busca con `reinforce: false`: lo que el usuario no pidió no es uso. Se mantiene dormido hasta comprobar que el servidor expone `reinforce`, así que se puede configurar antes de desplegar |
| `mismem-used` | `Stop` | Mira el último turno (lo que el modelo pidió con `recall` y lo que la inyección le puso delante) y refuerza sólo aquello cuyas palabras distintivas reaparecen en la respuesta. Es una aproximación: falla hacia no reforzar |

## Qué sale de la máquina

Lo inyectado viaja en **cada prompt** al proveedor del modelo, así que `MISMEM_HOOK_EXCLUDE_SCOPES`
decide qué ámbitos no salen. Antes de activarlo, `echo '{"prompt":"..."}' | mismem-inject --dry-run`
imprime los ids y los ámbitos de lo que elegiría, sin mandar nada.

## Refuerzo por uso

Con `MISMEM_REINFORCE_ON_RECALL=off`, la saliencia pasa a seguir el uso en vez de la aparición. Conviene
mirar antes qué reforzaría `mismem-used --dry-run` y, sólo entonces, apagarlo; las cifras y el motivo
están en DEPLOY.md.

## Montaje y variables

El montaje paso a paso (configuración de `settings.json`, el envoltorio `scripts/mismem-hook.sh`, la
espera a que el servidor esté listo) y todas las variables están en [DEPLOY.md](../DEPLOY.md):
[refuerzo por uso](../DEPLOY.md#refuerzo-por-uso-hook-del-cliente) y
[recuperación proactiva](../DEPLOY.md#recuperación-proactiva-hook-del-cliente).
