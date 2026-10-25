import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { applyTheme, loadTheme, resolveTheme } from "./lib/theme";

// La CSP del servidor prohíbe scripts inline, así que el tema no puede fijarse desde
// index.html: se aplica aquí, antes del primer render, para no pintar un tema y saltar a otro.
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Acceder a localStorage puede lanzar con cookies de terceros bloqueadas.
    return null;
  }
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(document.documentElement, resolveTheme(loadTheme(browserStorage()), prefersDark));

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
