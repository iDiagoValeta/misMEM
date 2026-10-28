# Commits

[Conventional Commits](https://www.conventionalcommits.org/), en inglés.

```
<tipo>(<ámbito opcional>)<!>: <asunto en imperativo>

<cuerpo: el porqué>
```

- **Tipos**: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- **Asunto**: imperativo, minúscula inicial, sin punto final, hasta 72 caracteres.
  `fix(ingest): skip ChatGPT conversations that carry no message text`.
- **Ámbito**: opcional; el área tocada (`ingest`, `dependabot`, `recall`).
- **Cuerpo**: explica por qué, no qué (el diff ya dice qué). Una referencia duradera (`#123`, una fecha
  medida) vale más que "como hablamos".
- **Un asunto por commit.** Si el diff mezcla dos, se parte antes de abrir el PR.
- **Cambio incompatible**: `!` tras el tipo o un pie `BREAKING CHANGE:`, más la etiqueta `breaking` en el
  PR y la nota de migración en el `CHANGELOG.md`.
- **El issue se cierra desde el PR** (`Closes #N` en su descripción), no desde cada commit.
- **Nunca** una clave, un `.env`, una base `*.db` ni un export personal. `gitleaks` revisa toda la
  historia en cada PR, pero un commit con un secreto ya es un secreto expuesto: se rota la clave, no
  basta con borrarla.

Comprobar un asunto: `^(feat|fix|docs|test|refactor|perf|chore|ci|build)(\([a-z0-9-]+\))?!?: .{1,72}$`.
Los commits de merge que genera GitHub (`Merge pull request #N from ...`) y los de `Merge branch`
quedan fuera de la regla.
