# Mapa de la documentación

Qué documento es para quién. Antes de crear uno nuevo, comprobar que no cabe en uno de estos.

| Documento | Para quién | Qué contiene |
|---|---|---|
| [`README.md`](../README.md) | Quien llega por primera vez | Qué es misMEM, cómo instalarlo y a dónde ir después |
| [`DEPLOY.md`](../DEPLOY.md) | Quien opera un servidor | Docker, Traefik, tareas programadas, respaldos y la **tabla única de variables de entorno** |
| [`docs/architecture.md`](architecture.md) | Quien quiere entender o tocar el motor | Las tres capas, las herramientas, el almacenamiento, la saliencia y el olvido, los componentes |
| [`docs/recall.md`](recall.md) | Quien ajusta o depura la búsqueda | Búsqueda por palabras, rescate, búsqueda por significado, reindexado |
| [`docs/hooks.md`](hooks.md) | Quien conecta un cliente | Los hooks de inyección y de refuerzo, y qué sale de la máquina |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Quien va a contribuir | Entorno, flujo, estándar de issue y de PR, etiquetas, releases |
| [`docs/standards/`](standards/README.md) | Quien contribuye | Ramas, commits, comentarios, estilo, tests, seguridad y releases, cada norma comprobable |
| [`AGENTS.md`](../AGENTS.md) | Agentes y personas que trabajan en el código | Contrato de trabajo: stack, convenciones, esquema, reglas de seguridad (`CLAUDE.md` lo importa y debe seguir siendo un puntero) |
| [`CHANGELOG.md`](../CHANGELOG.md) | Quien actualiza una versión | Qué cambió en cada versión y por qué; la historia vive aquí y en ningún otro sitio |
| [`SECURITY.md`](../SECURITY.md) | Quien encuentra una vulnerabilidad | Cómo reportarla en privado y qué cuenta como tal |
| [`engine/README.md`](../engine/README.md) | Quien ve el paquete en npm | Qué es y cómo se conecta; viaja dentro del tarball |
| [`engine/src/consolidation/README.md`](../engine/src/consolidation/README.md) | Quien opera o depura la consolidación | Cómo se destilan los episodios, qué se manda afuera y qué pasa con el ruido |
| `.env.example` | Quien configura un checkout | Sólo las variables más usadas; la lista completa es la tabla de `DEPLOY.md` |

Un `README.md` dentro de un directorio sólo existe donde el propósito del directorio no se lee en su
código; no hay uno por carpeta por defecto.

## Qué NO se documenta

Lo que el código ya dice sin ambigüedad: firmas de funciones, valores por defecto, listas de parámetros,
inventarios de módulos. Un documento que lo repite queda desfasado la primera vez que cambia el código y
no el documento. Se documenta la forma del sistema y el porqué de cada decisión; para el detalle se
enlaza al código.

Tampoco se documenta aquí:

- **Una variable de entorno fuera de la tabla de `DEPLOY.md`.** Se añade o se cambia allí y sólo allí; el
  resto de documentos enlaza.
- **El historial de iteraciones.** Un documento describe el código actual; cómo se llegó hasta él va en
  `CHANGELOG.md`.
- **Las convenciones de `AGENTS.md`.** Se enlazan, no se copian.
- **El contenido de ninguna memoria, ni el banco de preguntas de `mismem-bench`.** Son privados.

## Regla de oro

**Si un documento y el código discrepan, gana el código.** Se corrige el documento; no se racionaliza la
discrepancia. Vale para cada fichero de esta tabla, incluido este.

Para comprobarlo antes de dar algo por documentado: cada comando se ejecuta, cada flag se busca en
`engine/src/*-args.ts`, cada variable en `DEPLOY.md` y en el código que la lee, cada número en la
constante que lo fija.
