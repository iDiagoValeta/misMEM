import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { App } from "./App";
import { applyTheme, browserStorage, loadTheme, resolveTheme } from "./lib/theme";

// La CSP del servidor prohíbe scripts inline, así que el tema no puede fijarse desde
// index.html: se aplica aquí, antes del primer render, para no pintar un tema y saltar a otro.
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(document.documentElement, resolveTheme(loadTheme(browserStorage()), prefersDark));

// Las lecturas se comparten entre vistas; una escritura invalida lo que toca. Sin
// reintentos agresivos: un fallo de red debe enseñar el aviso pronto, no esconderse.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
