import { useEffect, useState } from "react";
import {
  applyTheme,
  browserStorage,
  loadTheme,
  resolveTheme,
  saveTheme,
  type ResolvedTheme,
  type ThemeChoice,
} from "@/lib/theme";

/** La elección guardada, la preferencia del sistema y el tema resuelto que se pinta. */
export function useTheme(): {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  resolved: ResolvedTheme;
} {
  const [choice, setChoice] = useState<ThemeChoice>(() => loadTheme(browserStorage()));
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolved = resolveTheme(choice, prefersDark);

  useEffect(() => {
    applyTheme(document.documentElement, resolved);
    saveTheme(browserStorage(), choice);
  }, [choice, resolved]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return { choice, setChoice, resolved };
}
