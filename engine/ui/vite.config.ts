import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// La interfaz se compila a dist/ui y la sirve server-http en /viewer. En desarrollo,
// `pnpm dev:ui` levanta Vite y manda /api al servidor de MISMEM_DEV_API (por defecto :3200).
export default defineConfig({
  root: __dirname,
  base: "/viewer/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mismo alias que en tsconfig.json: `@/lib/theme` apunta a ui/src/lib/theme.
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { "/api": process.env.MISMEM_DEV_API ?? "http://127.0.0.1:3200" },
  },
});
