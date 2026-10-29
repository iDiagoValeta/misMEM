/**
 * Respuestas HTTP que comparten el despacho (routes.ts) y los handlers del visor.
 *
 * Cada helper fija el estado y las cabeceras que ya enviaba server-http.ts, sin unificarlas:
 * el visor y el SDK del MCP leen content-type y caché tal cual, y cambiarlos altera el
 * contrato aunque el cuerpo sea el mismo.
 */
import type { ServerResponse } from "node:http";

/** JSON de la interfaz: UTF-8 explícito y sin caché. */
export function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** JSON sin charset ni caché: los errores JSON-RPC de /mcp y el 500 general. */
export function jsonBare(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

/** JSON UTF-8 y sin cabecera de caché: el 404 de una ruta /api que no existe. */
export function jsonPlain(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/** 401 de BasicAuth: sin el reto, el navegador no pide credenciales. */
export function unauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="misMEM"');
  res.end("No autorizado");
}

/** 404 de una ruta que no es de nadie. Sin content-type, como lo enviaba el servidor. */
export function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end("No encontrado");
}

/** 405 de /api para lo que no es GET ni POST. */
export function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader("allow", "GET, POST");
  res.end("Método no permitido");
}

/** 413 de /mcp: se cierra la conexión porque lo que queda del cuerpo no se drena. */
export function payloadTooLarge(res: ServerResponse): void {
  res.statusCode = 413;
  res.setHeader("connection", "close");
  res.end("Cuerpo demasiado grande");
}
