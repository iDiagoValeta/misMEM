# Normas

Reglas cortas para trabajar en este repositorio. [`CONTRIBUTING.md`](../../CONTRIBUTING.md) es la
puerta de entrada al flujo; aquí está el detalle. [`AGENTS.md`](../../AGENTS.md) manda en lo que cubre
(mapa del código, comandos, reglas duras, convenciones y trampas) y estas normas no lo repiten: lo enlazan.

| Norma | Qué fija |
|---|---|
| [Ramas](branches.md) | Trunk-based sobre `main`, nombres y vida de una rama |
| [Commits](commits.md) | Conventional Commits en inglés, y el porqué en el cuerpo |
| [Comentarios](comments.md) | Cuándo un comentario se gana su sitio, y en qué idioma |
| [Estilo de código](code-style.md) | Lo que `AGENTS.md` no dice: nombres y partición de ficheros, lint y dependencias |
| [Tests](tests.md) | Dónde vive cada test y qué exige un cambio |
| [Seguridad](security.md) | Secretos, dependencias, workflows e imagen |
| [Releases](releases.md) | Cómo se corta una versión y qué lleva el CHANGELOG |
| [Estándar de PR](../../CONTRIBUTING.md#estándar-de-pr) | Vive en `CONTRIBUTING.md` |
| [Estándar de issue](../../CONTRIBUTING.md#estándar-de-issue) | Vive en `CONTRIBUTING.md` |

Una norma que se puede comprobar con una máquina se comprueba (CI, un test, `knip`, Biome); las demás
dicen cómo revisarlas. Si una norma y la práctica discrepan, se arregla una de las dos en un PR: no se
deja que convivan.
