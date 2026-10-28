# Ramas

Trunk-based: `main` es la única rama larga y siempre se puede publicar.

- **Nombre**: `<tipo>/<tema>`, en inglés, minúsculas ASCII y guiones: `fix/recall-empty-scope`,
  `docs/contribution-standard`.
- **Tipos**: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`. Son los mismos
  de [Commits](commits.md); el tipo de la rama es el del cambio principal.
- **Un issue por rama y un asunto por rama.** La rama sale de `main` y vive lo que dure su issue. Si el
  trabajo mezcla dos asuntos, se parte en dos ramas.
- **Nada se empuja directo a `main`.** Todo entra por PR con CI en verde (ver
  [`CONTRIBUTING.md`](../../CONTRIBUTING.md#flujo-de-trabajo)). Nunca `git push --force` sin permiso
  expreso ([`AGENTS.md`](../../AGENTS.md)).
- **Ponerse al día con `main`** se hace fusionando `main` en la rama; lo ya publicado no se reescribe.
- **Merge commit**, no squash ni rebase: los commits de la rama quedan en la historia con su porqué.
  Después se borra la rama, la local y la remota.
- **Excepción, Dependabot**: sus ramas se llaman `dependabot/<ecosistema>/...`.
  Las crea el bot y no se renombran; se mergean igual que el resto, con CI en verde.
- **Las releases no tienen rama propia larga**: son un tag sobre `main` ([Releases](releases.md)).

Comprobar: `git branch --list` no muestra nada fuera de `main` y de las ramas de un issue abierto, y el
nombre de cada rama cumple `^(feat|fix|docs|test|refactor|perf|chore|ci|build)/[a-z0-9]+(-[a-z0-9]+)*$`.
