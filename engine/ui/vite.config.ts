import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La interfaz se compila a dist/ui y la sirve server-http en /viewer. En desarrollo,
// `pnpm dev:ui` levanta Vite y manda /api al servidor de MISMEM_DEV_API (por defecto :3200).
export default defineConfig({
  root: __dirname,
  base: "/viewer/",
  plugins: [react()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { "/api": process.env.MISMEM_DEV_API ?? "http://127.0.0.1:3200" },
  },
});
