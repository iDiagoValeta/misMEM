<!--
Actualización de dependencias, a mano o la de Dependabot. Se abre con
?template=dependency.md en la URL de comparación (ver la plantilla por defecto).
Política: docs/standards/security.md.
-->
## Qué se mueve

| Paquete, acción o imagen | De | A | Dónde (`engine/`, workflow, Dockerfile) |
|---|---|---|---|

## Verificación

- [ ] La versión nueva se publicó hace 14 días o más (fecha de release: )
- [ ] Notas de cambios o changelog de la dependencia leídos; resumen:
- [ ] Cambios incompatibles: ninguno, o cuáles y qué se adaptó
- [ ] Entra con versión exacta, sin `^` ni `~` (un rango existente se fija al subirlo)
- [ ] Si trae scripts de instalación (`postinstall`), auditados antes de permitirlos en `pnpm-workspace.yaml`
- [ ] CI en verde, incluidos `docker-build` y el smoke de `/healthz` si cambia el runtime, `better-sqlite3` o la imagen base
- [ ] Línea en `CHANGELOG.md` si cambia lo que recibe quien instala (dependencia de producción o imagen)

<!-- labels:begin -->
Etiquetas: `dependencies` (Dependabot la pone sola), y `breaking` si hay cambios incompatibles.
<!-- labels:end -->
