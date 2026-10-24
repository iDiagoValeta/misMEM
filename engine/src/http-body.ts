/**
 * Lectura del cuerpo de `POST /mcp` con tope de tamaño.
 *
 * El transporte del SDK hace `req.json()` sin límite: un cuerpo de un giga se junta
 * entero en memoria antes de fallar. Acá se lee antes, se corta en cuanto pasa el
 * tope y el JSON ya parseado se le pasa al transporte, que entonces no vuelve a leer.
 */
import type { IncomingMessage } from "node:http";

/** De sobra para una tool call; la ingesta masiva va por `mismem-ingest`, no por HTTP. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

export class InvalidJsonError extends Error {
  override name = "InvalidJsonError";
}

export function loadMaxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MISMEM_HTTP_MAX_BODY_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BODY_BYTES;
}

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Con Content-Length el exceso se sabe antes de leer un byte.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new BodyTooLargeError(`cuerpo de ${declared} bytes, el tope es ${maxBytes}`));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        // Sin Content-Length (chunked) sólo se puede cortar al pasarse. Se pausa en vez
        // de destruir: destruir el request cierra el socket y el 413 no llegaría.
        stop();
        req.pause();
        reject(new BodyTooLargeError(`cuerpo de más de ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new InvalidJsonError((err as Error).message));
      }
    };
    const onError = (err: Error): void => {
      stop();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
