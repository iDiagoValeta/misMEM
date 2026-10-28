import { z } from "zod";

const MAX_GIST_CHARS = 500;

const MemorySchema = z.object({
  gist: z.string().min(1),
  details: z.string().optional().nullable(),
  evidence_episode_ids: z.array(z.string()).min(1),
  type: z.string().min(1).max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type DistilledMemory = z.infer<typeof MemorySchema>;

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
  maxTokens?: number;
  /** Tope por llamada: sin él, un proveedor que acepta y no contesta colgaba la corrida. */
  timeoutMs?: number;
}

// El máximo de salida de deepseek-chat: menos corta respuestas de tandas grandes.
const DEFAULT_MAX_TOKENS = 8192;

/** Credenciales o saldo: reintentar con otro ámbito daría el mismo error. */
export class LlmFatalError extends Error {
  override name = "LlmFatalError";
}

/** La respuesta llegó al tope de tokens: con menos episodios entra. */
export class LlmTruncatedError extends Error {
  override name = "LlmTruncatedError";
}

/** La respuesta no es JSON válido: con una tanda más chica suele salir bien. */
export class LlmInvalidJsonError extends Error {
  override name = "LlmInvalidJsonError";
}

// De sobra para generar 8192 tokens; lo que tarde más es un proveedor colgado.
const DEFAULT_TIMEOUT_MS = 120_000;

function loadTimeoutMs(): number {
  const value = Number(process.env.MISMEM_CONSOLIDATION_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function loadMaxTokens(): number {
  const value = Number(process.env.MISMEM_CONSOLIDATION_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

type LlmProvider = "deepseek" | "openrouter" | "openai" | "compatible";

const PROVIDERS: readonly LlmProvider[] = ["deepseek", "openrouter", "openai", "compatible"];

/** Sin MISMEM_LLM_PROVIDER, el primero que tenga su variable, en el orden de siempre. */
function pickProvider(): LlmProvider | undefined {
  const explicit = process.env.MISMEM_LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!(PROVIDERS as readonly string[]).includes(explicit)) {
      throw new Error(`MISMEM_LLM_PROVIDER=${explicit} no existe: usar ${PROVIDERS.join(", ")}`);
    }
    return explicit as LlmProvider;
  }
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.MISMEM_LLM_BASE_URL) return "compatible";
  return undefined;
}

function required(name: string, provider: LlmProvider): string {
  const value = process.env[name];
  if (!value) throw new Error(`Con el proveedor ${provider} falta ${name}.`);
  return value;
}

/**
 * Con OpenAI o un servidor compatible no hay un modelo por defecto que valga: elegirlo es
 * una decisión de coste de quien paga, y un nombre fijado acá caducaría.
 */
function requiredModel(provider: LlmProvider): string {
  const model = process.env.MISMEM_CONSOLIDATION_MODEL;
  if (!model) throw new Error(`Con el proveedor ${provider} hay que elegir el modelo en MISMEM_CONSOLIDATION_MODEL.`);
  return model;
}

export function loadLlmConfig(): LlmConfig {
  const configured = process.env.MISMEM_CONSOLIDATION_MODEL;
  const limits = { maxTokens: loadMaxTokens(), timeoutMs: loadTimeoutMs() };
  const provider = pickProvider();
  switch (provider) {
    case "deepseek":
      return {
        apiKey: required("DEEPSEEK_API_KEY", provider),
        // "deepseek/deepseek-chat" es el nombre en OpenRouter; DeepSeek no lo acepta.
        model: configured && !configured.includes("/") ? configured : "deepseek-chat",
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        ...limits,
      };
    case "openrouter":
      return {
        apiKey: required("OPENROUTER_API_KEY", provider),
        model: configured ?? "deepseek/deepseek-chat",
        baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        appUrl: process.env.OPENROUTER_APP_URL ?? "https://github.com/lucasmella-stack/misMEM",
        appTitle: process.env.OPENROUTER_APP_TITLE ?? "misMEM",
        ...limits,
      };
    case "openai":
      return {
        apiKey: required("OPENAI_API_KEY", provider),
        model: requiredModel(provider),
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        ...limits,
      };
    case "compatible":
      return {
        // Un servidor local (Ollama, LM Studio, vLLM) puede no pedir clave.
        apiKey: process.env.MISMEM_LLM_API_KEY ?? "",
        model: requiredModel(provider),
        baseUrl: required("MISMEM_LLM_BASE_URL", provider).replace(/\/+$/, ""),
        ...limits,
      };
    default:
      throw new Error(
        "Falta un proveedor para consolidar: DEEPSEEK_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY " +
          "o MISMEM_LLM_BASE_URL (un servidor compatible con la API de OpenAI). Ver MISMEM_LLM_PROVIDER.",
      );
  }
}

export async function distill(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<DistilledMemory[]> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // La misma señal corta también la lectura del cuerpo, que es donde se cuelga un stream a medias.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await request(cfg, systemPrompt, userPrompt, signal);
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      throw new Error(`LLM sin respuesta en ${timeoutMs} ms`);
    }
    throw err;
  }
}

async function request(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<DistilledMemory[]> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      ...(cfg.appUrl ? { "HTTP-Referer": cfg.appUrl } : {}),
      ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const message = `LLM HTTP ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new LlmFatalError(message);
    }
    throw new Error(message);
  }

  const json = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
  };
  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new LlmTruncatedError(`respuesta cortada en ${cfg.maxTokens ?? DEFAULT_MAX_TOKENS} tokens`);
  }
  const content = choice?.message?.content;
  if (!content) {
    throw new Error("Respuesta del LLM sin choices[0].message.content");
  }

  const cleaned = stripFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Sin el texto de la respuesta: son recuerdos de la persona y este error termina en un log.
    throw new LlmInvalidJsonError(
      `LLM devolvi\u00f3 JSON inv\u00e1lido (${cleaned.length} caracteres): ${(err as Error).name}`,
    );
  }
  const root = z.object({ memories: z.array(z.unknown()) }).safeParse(parsed);
  if (!root.success) {
    throw new LlmInvalidJsonError("la respuesta del LLM no trae la lista de memorias");
  }
  const memories = root.data.memories.map((raw) => MemorySchema.safeParse(raw));
  const invalid = memories.filter((m) => !m.success).length;
  if (invalid > 0) {
    // Quedarse con las válidas dejaría sin citar, y por lo tanto como ruido, a los episodios de las otras.
    throw new LlmInvalidJsonError(`${invalid} de ${memories.length} memorias del LLM mal formadas`);
  }
  return memories.flatMap((m) => (m.success ? [fitGist(m.data)] : []));
}

function fitGist(memory: DistilledMemory): DistilledMemory {
  if (memory.gist.length <= MAX_GIST_CHARS) return memory;
  return {
    ...memory,
    gist: memory.gist.slice(0, MAX_GIST_CHARS),
    details: [memory.gist.trim(), memory.details].filter(Boolean).join("\n"),
  };
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return trimmed;
}
