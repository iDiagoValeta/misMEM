/** Los errores del fetch ya traen el mensaje del servidor; lo demás se enseña tal cual. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
