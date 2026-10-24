/**
 * Qué `Host` atiende el servidor HTTP cuando corre sin auth.
 *
 * Sin credenciales, lo único que separa la memoria de una web cualquiera es que el
 * navegador no la deja hablar con otro origen. DNS rebinding se salta eso: el dominio
 * del atacante pasa a resolver a 127.0.0.1 y, para el navegador, la petición es del
 * mismo origen. Lo que la delata es el `Host`, que sigue siendo el del atacante.
 * Con auth no hace falta: el navegador no manda credenciales a un origen ajeno, y
 * detrás de un proxy el `Host` es el dominio público.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** El nombre de la cabecera `Host`, sin puerto, sin corchetes y en minúsculas. */
export function hostName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  let name = header.trim().toLowerCase();
  if (name.startsWith("[")) {
    name = name.slice(1, name.indexOf("]"));
  } else {
    const colon = name.lastIndexOf(":");
    if (colon >= 0) name = name.slice(0, colon);
  }
  name = name.replace(/\.$/, "");
  return name || undefined;
}

/** `MISMEM_ALLOWED_HOSTS`: nombres separados por comas. */
export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => hostName(part))
    .filter((part): part is string => Boolean(part));
}

export function hostAllowed(
  header: string | undefined,
  opts: { auth: boolean; extra: readonly string[] },
): boolean {
  if (opts.auth) return true;
  const name = hostName(header);
  if (!name) return false;
  return LOOPBACK.has(name) || name.endsWith(".localhost") || opts.extra.includes(name);
}
