import { z } from "zod";

const MemorySchema = z.object({
  gist: z.string().min(1).max(500),
  details: z.string().optional().nullable(),
  evidence_episode_ids: z.array(z.string()).min(1),
  type: z.string().min(1).max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ResponseSchema = z.object({
  memories: z.array(MemorySchema),
});

export type DistilledMemory = z.infer<typeof MemorySchema>;

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
  maxTokens?: number;
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

function loadMaxTokens(): number {
  const value = Number(process.env.MISMEM_CONSOLIDATION_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

export function loadLlmConfig(): LlmConfig {
  const configured = process.env.MISMEM_CONSOLIDATION_MODEL;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    return {
      apiKey: deepseekKey,
      // "deepseek/deepseek-chat" es el nombre en OpenRouter; DeepSeek no lo acepta.
      model: configured && !configured.includes("/") ? configured : "deepseek-chat",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      maxTokens: loadMaxTokens(),
    };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Falta DEEPSEEK_API_KEY u OPENROUTER_API_KEY. Setear una como env var antes de consolidar.",
    );
  }
  return {
    apiKey,
    model: configured ?? "deepseek/deepseek-chat",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    appUrl: process.env.OPENROUTER_APP_URL ?? "https://github.com/lucasmella-stack/misMEM",
    appTitle: process.env.OPENROUTER_APP_TITLE ?? "misMEM",
    maxTokens: loadMaxTokens(),
  };
}

export async function distill(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<DistilledMemory[]> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
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
    throw new LlmInvalidJsonError(
      `LLM devolvi\u00f3 JSON inv\u00e1lido: ${(err as Error).message}\nRaw: ${cleaned.slice(0, 500)}`,
    );
  }
  const root = z
    .object({ memories: z.array(z.unknown()) })
    .parse(parsed);
  const out: DistilledMemory[] = [];
  for (const raw of root.memories) {
    const r = MemorySchema.safeParse(raw);
    if (r.success) out.push(r.data);
  }
  return out;
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
