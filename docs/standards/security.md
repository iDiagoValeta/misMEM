# Seguridad

Las reglas de [`AGENTS.md`](../../AGENTS.md) (no leer ni editar `.env*`, no tocar `db.ts` sin plan de
migración, validar en los bordes con Zod) siguen mandando. Esto es lo que las completa.

## Secretos y datos

- Nunca en git: `.env*` (salvo `.env.example`, que sólo lleva nombres), bases `*.db` y sus `-wal`,
  `-shm` y `-journal`, exports de ChatGPT, volcados de Engram. Están en `.gitignore`.
- `gitleaks` revisa toda la historia en cada PR. Una clave filtrada se **rota primero**; después se
  reporta en privado ([`SECURITY.md`](../../SECURITY.md)). Nunca como un issue público.
- Los logs, los volcados y los issues no llevan texto de memorias ni claves. El banco de `mismem-bench` es
  privado y no se sube a ningún repositorio.
- Las claves de proveedores viven en `~/.config/mismem/env` con permisos 600 (lo hace `install.sh`) o en
  el entorno del contenedor; ninguna en la configuración de un cliente.
- El servidor HTTP escucha en loopback por defecto. Exponerlo sin `MISMEM_AUTH_USER` y `MISMEM_AUTH_PASS`
  (o un proxy con autenticación) no está soportado.

## Dependencias

- **Toda dependencia que se añade o se sube entra con versión exacta y publicada hace 14 días o más.**
  Los rangos con `^` que ya hay en `engine/package.json` (por ejemplo `typescript`, `vite`, `vitest`,
  `react`, `@types/node`) se fijan la próxima vez que se suban; no se reescriben todos de golpe.
  Dependabot aplica los 14 días con `cooldown: default-days: 14` en sus tres ecosistemas.
- Los majors de `node` en el Dockerfile se mueven a mano, a una LTS; Dependabot los ignora.
- Un script de instalación nuevo (`postinstall`) se audita antes de autorizarlo en
  `engine/pnpm-workspace.yaml`.
- La imagen base va fijada por digest, con el tag legible al lado.
- Un PR de dependencias usa la plantilla `dependency.md` ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).

## Workflows

- Cada action va fijada por SHA con la versión en un comentario (`# v4.4.0`); Dependabot mueve las dos.
- `permissions` mínimos (`contents: read` por defecto, `packages: write` sólo en el job que publica),
  `persist-credentials: false` en cada checkout y `timeout-minutes` en cada job con pasos (el job de
  `docker.yml` que sólo llama al workflow reutilizable no puede llevar pasos ni ese límite).
- El job `workflow-lint` (actionlint y zizmor) y `secret-scan` (gitleaks) corren en cada PR.
- Un valor que viene de un evento (rama, título de PR) no se interpola en un `run:`: va por `env:`.
