# Comentarios

Un comentario explica **para qué** (la restricción, el motivo, lo que se descartó), nunca **qué** hace la
línea ([`AGENTS.md`](../../AGENTS.md)). Si repite el código de debajo, se borra.

Bien, deja constancia de una restricción:

```ts
// Menor que un puesto de RRF en la cima (1/61 - 1/62): la saliencia desempata, no reordena.
const SALIENCE_RRF_WEIGHT = 0.0002;
```

Mal, repite el código:

```ts
// Recorre los candidatos.
for (const candidate of candidates) {
```

- **Idioma**: los comentarios nuevos o reescritos, en inglés. Los que ya están en español no se traducen
  en masa; se traducen cuando se reescriben por otro motivo.
- **Nada de código comentado.** Se borra: git lo recuerda.
- **Una supresión de Biome lleva su porqué** (`// biome-ignore lint/...: <motivo>`): en este repositorio
  siempre se escribe. `biome.json` es JSON estricto y no admite comentarios, así que el porqué de una regla
  desactivada va en el `CHANGELOG.md`.
- **Sin `TODO` ni `FIXME` sueltos**: o llevan el issue (`TODO(#123): ...`) o se abre el issue y se quita
  el comentario. Comprobar: `grep -rnE "TODO|FIXME" engine/src engine/ui/src engine/tests`.
- **Los mensajes de cara al usuario no son comentarios**: errores, logs, ayuda de los CLI y la interfaz
  van en español ([Estilo de código](code-style.md)).
