# Estilo de código

La fuente de las convenciones es [`AGENTS.md`](../../AGENTS.md): TypeScript estricto sin `any`, Zod en los
bordes, funciones puras con inyección de dependencias, ESM con imports `.js`, ULID, `better-sqlite3`
dentro de `db.transaction`. Aquí sólo lo que `AGENTS.md` no dice.

## Idioma

| Dónde | Idioma |
|---|---|
| Identificadores, claves JSON, comentarios nuevos, commits | inglés |
| Errores, logs, ayuda de los CLI, interfaz | español |
| Documentación en Markdown | español neutro: formas impersonales, ni voseo ni vosotros |

## Ficheros

- Minúsculas con guiones: `server-http.ts`, `hook-readiness.ts`.
- Un CLI con flags propios son dos ficheros: `<cli>-cli.ts` (lo ejecuta) y `<cli>-args.ts` (lee los
  argumentos sin tocar la base). Un flag o posicional desconocido corta con `argumento desconocido: <x>` y
  sale con código 64 (`EXIT_USAGE` en `cli-args.ts`); un fallo del CLI sale por stderr con el prefijo
  `ERROR:`.
- Excepciones, cada una con su razón: `inject-cli.ts` y `used-cli.ts` son hooks que nunca pueden cortar un
  prompt ni salir con error, así que leen sus pocos argumentos en línea y ignoran lo que no entienden;
  `obsidian-cli.ts` lee sus argumentos estrictamente, pero en línea.
- Un binario nuevo se declara en `bin` de `engine/package.json` y se nombra `mismem-<cosa>`.
- Un fichero que supera con claridad su responsabilidad se parte por responsabilidades, no por tamaño.

## Formato y lint

- Biome corre **sólo como linter** (`pnpm lint`); el formato no se automatiza. Se imita el del fichero
  que se edita: dos espacios, comillas dobles, punto y coma.
- Una regla de Biome desactivada se justifica en el `CHANGELOG.md` ([Comentarios](comments.md)).
- `pnpm knip` falla con ficheros, exports y dependencias sin uso: no se deja código por si acaso.
- `pnpm dup` falla si el código copiado de 10 líneas o más supera el 0,2 %: se extrae, no se pega.
- Una dependencia nueva se justifica en el PR y entra con versión exacta ([Seguridad](security.md)).

## Esquema

`engine/src/db.ts` (el `SCHEMA` y las migraciones aditivas) no se toca sin plan de migración, porque
rompe la base en producción ([`AGENTS.md`](../../AGENTS.md)). El cambio lleva su migración aditiva, su
test y su línea en el `CHANGELOG.md`.
