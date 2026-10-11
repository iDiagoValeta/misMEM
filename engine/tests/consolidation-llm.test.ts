import { afterEach, describe, expect, it, vi } from "vitest";
import {
  distill,
  loadLlmConfig,
  LlmFatalError,
  LlmInvalidJsonError,
  LlmTruncatedError,
} from "../src/consolidation/llm.js";

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "MISMEM_CONSOLIDATION_MODEL",
  "MISMEM_CONSOLIDATION_MAX_TOKENS",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

describe("loadLlmConfig", () => {
  it("con DEEPSEEK_API_KEY va directo a DeepSeek, aunque también haya OpenRouter", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", OPENROUTER_API_KEY: "sk-or" });
    const cfg = loadLlmConfig();
    expect(cfg.apiKey).toBe("sk-ds");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg.model).toBe("deepseek-chat");
  });

  it("en DeepSeek ignora un modelo con nombre de OpenRouter y respeta uno propio", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MODEL: "deepseek/deepseek-chat" });
    expect(loadLlmConfig().model).toBe("deepseek-chat");
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MODEL: "deepseek-reasoner" });
    expect(loadLlmConfig().model).toBe("deepseek-reasoner");
  });

  it("sin DeepSeek sigue usando OpenRouter", () => {
    setEnv({ OPENROUTER_API_KEY: "sk-or" });
    const cfg = loadLlmConfig();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toBe("deepseek/deepseek-chat");
  });

  it("sin ninguna clave avisa de las dos", () => {
    setEnv({});
    expect(() => loadLlmConfig()).toThrow(/DEEPSEEK_API_KEY.*OPENROUTER_API_KEY/);
  });

  it("pone un tope a la respuesta: 8192 tokens salvo que se configure otro", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds" });
    expect(loadLlmConfig().maxTokens).toBe(8192);
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MAX_TOKENS: "2000" });
    expect(loadLlmConfig().maxTokens).toBe(2000);
  });
});

describe("distill", () => {
  const cfg = { apiKey: "k", model: "deepseek-chat", baseUrl: "https://llm.test/v1", maxTokens: 1234 };

  it("manda el tope de tokens en el pedido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await distill(cfg, "sys", "user");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBe(1234);
  });

  it.each([401, 402, 403])("un HTTP %i es fatal: no tiene sentido seguir con otros ámbitos", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sin saldo", { status })));
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmFatalError);
  });

  it("una respuesta cortada por el tope de tokens se distingue de un JSON roto", async () => {
    const cut = '{"memories":[{"gist":"algo","details":"sin terminar';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: cut } }] })),
      ),
    );
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmTruncatedError);
  });

  it("un JSON mal armado (sin estar cortado) se distingue para poder partir la tanda", async () => {
    const broken = '{"memories":[{"gist":"a","evidence_episode_ids":["x"]} {"gist":"b"}]}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: broken } }] })),
      ),
    );
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmInvalidJsonError);
  });

  it("un 500 no es fatal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    const err = await distill(cfg, "sys", "user").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmFatalError);
  });
});
