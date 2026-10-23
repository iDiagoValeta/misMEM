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
  result?: unknown;
  error?: { message?: string };
}

function authHeader(): string | undefined {
  // El header entero evita copiar la credencial a una variable nueva: el hook la
  // puede sacar de donde ya vive (la config MCP del cliente) y pasarla tal cual.
  const direct = process.env.MISMEM_HOOK_AUTH_HEADER;
  if (direct) return direct;
  const basic = process.env.MISMEM_HOOK_AUTH;
  return basic ? `Basic ${Buffer.from(basic).toString("base64")}` : undefined;
}

/** Un JSON-RPC contra `/mcp`. El servidor no pide handshake para `tools/*`. */
export async function rpc(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const auth = authHeader();
  if (auth) headers.authorization = auth;

  const res = await fetch(`${url.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parseRpc(await res.text()) as RpcResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? "error del servidor");
  return parsed.result;
}

/** Llama una tool y devuelve el JSON que puso en el texto. */
export async function callRemoteTool(
  url: string,
  name: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const result = (await rpc(url, "tools/call", { name, arguments: args }, timeoutMs)) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

/** Qué tools expone el servidor: sirve para no hablarle de más a una versión vieja. */
export async function remoteToolNames(url: string, timeoutMs: number): Promise<string[]> {
  const result = (await rpc(url, "tools/list", {}, timeoutMs)) as {
    tools?: Array<{ name?: string }>;
  };
  return (result?.tools ?? []).map((t) => t.name ?? "").filter(Boolean);
}
