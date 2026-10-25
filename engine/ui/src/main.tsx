import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
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
      {/* `user` respeta prefers-reduced-motion: las microinteracciones no se imponen. */}
      <MotionConfig reducedMotion="user">
        {/* `strict` obliga a usar `m` y evita arrastrar la API completa de motion. */}
        <LazyMotion features={domAnimation} strict>
          <App />
        </LazyMotion>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
