/**
 * Cliente mínimo para que los hooks le hablen a misMEM: al servidor remoto por
 * JSON-RPC si hay MISMEM_HOOK_URL, o a la base local si no.
 *
 * Un hook corre en cada turno, así que todo tiene tope de tiempo y nada tira
 * excepciones hacia arriba sin que el llamador decida qué hacer.
 */

/** El servidor enmarca el JSON-RPC como SSE: la carga viene en una línea `data:`. */
export function parseRpc(body: string): unknown {
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : body);
}

interface RpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { message?: string };
}

/** Llama una tool del servidor remoto y devuelve el JSON que puso en el texto. */
export async function callRemoteTool(
  url: string,
  name: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const auth = process.env.MISMEM_HOOK_AUTH;
  if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;

  const res = await fetch(`${url.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parseRpc(await res.text()) as RpcResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? "error del servidor");
  const text = parsed.result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}
