/** El tema se resuelve en el cliente y se pinta con un atributo: la CSP prohíbe scripts inline. */

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "mismem-theme";

/** Acceder a localStorage puede lanzar con cookies de terceros bloqueadas. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/**
 * Sin almacenamiento, con la lectura bloqueada o con basura guardada se arranca en oscuro:
 * es el tema de partida del diseño y el que no depende de la preferencia del sistema.
 */
export function loadTheme(storage: Pick<Storage, "getItem"> | null): ThemeChoice {
  if (!storage) return "dark";
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // Navegación privada o permisos restringidos: se ignora y se sigue con el valor por defecto.
  }
  return "dark";
}

/** Guardar es best-effort: si el navegador rechaza la escritura, el tema sigue funcionando en esta visita. */
export function saveTheme(storage: Pick<Storage, "setItem"> | null, choice: ThemeChoice): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, choice);
  } catch {
    // Sin cuota o sin permisos no hay nada que hacer; no debe romper el cambio de tema.
  }
}

export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.setAttribute("data-theme", resolved);
}
