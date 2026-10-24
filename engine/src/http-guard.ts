/**
 * Lo que el servidor HTTP decide antes de atender una petición. Vive aparte de
 * server-http.ts, que escucha al importarse, para poder probarlo.
 */

export interface BasicCredentials {
  user: string;
  pass: string;
}

/**
 * Sin ninguna de las dos variables no hay auth (uso local). Con una sola, el servidor
 * no arranca: antes arrancaba abierto y sin avisar, que es justo lo contrario de lo que
 * quería quien definió la otra.
 */
export function loadAuth(env: NodeJS.ProcessEnv = process.env): BasicCredentials | null {
  const user = env.MISMEM_AUTH_USER;
  const pass = env.MISMEM_AUTH_PASS;
  if (!user && !pass) return null;
  if (!user) throw new Error("MISMEM_AUTH_PASS está definida pero falta MISMEM_AUTH_USER");
  if (!pass) throw new Error("MISMEM_AUTH_USER está definida pero falta MISMEM_AUTH_PASS");
  return { user, pass };
}
