/**
 * Sirve la interfaz compilada (engine/ui → dist/ui) en /viewer.
 *
 * Los ficheros de assets/ llevan el hash en el nombre: se cachean para siempre. El
 * index.html no, porque es el que apunta a los hashes de la versión que corre.
 */
import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Junto al server-http.js compilado: dist/ui. */
export const DEFAULT_UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

// Los scripts sólo del propio servidor. Los estilos además admiten inline: la librería del
// grafo inserta sus propios <style> (tooltip) y sin esto el navegador los bloquea. Un estilo
// inyectado no ejecuta código; lo que importa cerrar es script-src.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

/** `pathname` es el de la URL: /, /viewer, /viewer/ o /viewer/assets/… */
export function serveUi(res: ServerResponse, pathname: string, dir = DEFAULT_UI_DIR): void {
  const root = resolve(dir);
  const relative = pathname.replace(/^\/(viewer\/?)?/, "");

  if (relative && relative !== "index.html") {
    try {
      // Un % mal formado hace lanzar a decodeURIComponent: también es un 404.
      const file = resolve(root, decodeURIComponent(relative));
      // Nada fuera de dist/ui, aunque la ruta traiga `..` codificado.
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error("fuera de la interfaz");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      return send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", readFileSync(file));
    } catch {
      return send(res, 404, "text/plain; charset=utf-8", "Not Found");
    }
  }

  let html: Buffer;
  try {
    html = readFileSync(join(root, "index.html"));
  } catch {
    // Pasa corriendo con tsx sin compilar, o con un paquete armado sin la interfaz.
    return send(
      res,
      503,
      "text/plain; charset=utf-8",
      "La interfaz de misMEM no está compilada: corre `pnpm build` en engine/ y reinicia el servidor.",
    );
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", CSP);
  res.setHeader("referrer-policy", "no-referrer");
  send(res, 200, TYPES[".html"] as string, html);
}
