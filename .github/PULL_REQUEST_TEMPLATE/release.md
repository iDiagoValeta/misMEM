<!--
Release: sube la versión y cierra la sección del CHANGELOG. Se abre con
?template=release.md en la URL de comparación (ver la plantilla por defecto).
Pasos y porqué: docs/standards/releases.md.
-->
## Versión

`vX.Y.Z`: patch, minor o major, y por qué.

## Cambios

- [ ] `engine/package.json` y los dos campos de `server.json` con la misma versión (`tests/version.test.ts` lo comprueba)
- [ ] La sección "Sin publicar" de `CHANGELOG.md` pasa a `## X.Y.Z — AAAA-MM-DD` y queda una "Sin publicar" vacía arriba
- [ ] Cada cambio incompatible tiene su nota de migración en esa sección

## Verificación previa

Desde `engine/`:

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm knip`, `pnpm dup`, `pnpm lint` y `pnpm build` en verde
- [ ] CI del PR en verde, incluidos `docker-build` y el smoke de `/healthz`
- [ ] `mismem-bench` con las cifras de esta versión, si cambió el recall (van a las notas)

## Después de mergear

Con merge commit, sobre `main` actualizado:

- [ ] Tag anotado: `git tag -a vX.Y.Z -m 'misMEM X.Y.Z'` y `git push origin vX.Y.Z`
- [ ] El workflow `docker` del tag en verde: pasa el CI y publica la imagen (si falla al empujar, ver `DEPLOY.md`)
- [ ] GitHub release sobre el tag, con las notas generadas (agrupadas por `.github/release.yml`) y la sección del CHANGELOG
- [ ] `pnpm publish` desde `engine/`, a mano: ningún workflow lo hace
- [ ] Rama borrada
