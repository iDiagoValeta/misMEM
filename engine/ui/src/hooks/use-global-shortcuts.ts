import { useEffect, type RefObject } from "react";
import type { Selection } from "@/lib/selection";

/** Radix monta los diálogos fuera de <dialog>: Escape debe respetar ambos mundos. */
function hasOpenDialog(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]',
    ),
  );
}

/**
 * `/` enfoca la búsqueda y Escape cierra el detalle, salvo que haya un diálogo abierto:
 * ése se cierra solo y el detalle debe seguir detrás.
 */
export function useGlobalShortcuts(
  searchRef: RefObject<HTMLInputElement | null>,
  setSelected: (selection: Selection | undefined) => void,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const editing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !editing && !hasOpenDialog() && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Escape cierra el detalle salvo que lo esté usando un diálogo abierto, que se cierra solo.
      if (event.key === "Escape" && !hasOpenDialog()) setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchRef, setSelected]);
}
