import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture } from "../src/tools.js";
import { runConsolidation } from "../src/consolidation/run.js";
import { LlmFatalError, LlmInvalidJsonError, LlmTruncatedError } from "../src/consolidation/llm.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

const llmCfg = { apiKey: "x", model: "x", baseUrl: "x" };

function captureOld(scope: string, body: string, ageHours: number): string {
  const { id } = capture(db, { scope, body });
  const ts = Date.now() - ageHours * 3600 * 1000;
  db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(ts, id);
  return id;
}

describe("runConsolidation", () => {
  it("skipea scopes con menos episodios que minEpisodes", async () => {
    captureOld("solo", "uno", 48);
    captureOld("solo", "dos", 48);
    const distillFn = vi.fn();

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 3,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.scopes_skipped_too_few).toBe(1);
    expect(summary.memories_created).toBe(0);
  });

  it("ignora episodios m\u00e1s nuevos que minAgeHours", async () => {
    capture(db, { scope: "fresh", body: "ahora 1" });
    capture(db, { scope: "fresh", body: "ahora 2" });
    capture(db, { scope: "fresh", body: "ahora 3" });
    const distillFn = vi.fn();

    const summary = await runConsolidation(db, {
      minAgeHours: 24,
      minEpisodesPerScope: 1,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.scopes_seen).toBe(0);
  });

  it("destila y consolida episodios v\u00e1lidos via mock LLM", async () => {
    const ids = [
      captureOld("proj-x", "decidimos usar Zustand", 48),
      captureOld("proj-x", "porque Redux era overkill", 48),
      captureOld("proj-x", "migrar UserStore primero", 48),
    ];

    const distillFn = vi.fn().mockResolvedValue([
      {
        gist: "Decisi\u00f3n: Zustand sobre Redux para state",
        details: "Why: Redux era overkill\nWhere: UserStore primero",
        evidence_episode_ids: ids,
        type: "decision",
        confidence: 0.9,
      },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);

    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    const mem = db
      .prepare("SELECT scope, gist, salience FROM memories LIMIT 1")
      .get() as { scope: string; gist: string; salience: number };
    expect(mem.scope).toBe("proj-x");
    expect(mem.salience).toBe(0.9);
  });

  it("crea memoria stub con salience baja cuando LLM dice sin se\u00f1al", async () => {
    captureOld("noise", "ok", 48);
    captureOld("noise", "dale", 48);
    captureOld("noise", "listo", 48);

    const distillFn = vi.fn().mockResolvedValue([]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);
    const mem = db.prepare("SELECT salience FROM memories LIMIT 1").get() as { salience: number };
    expect(mem.salience).toBeLessThan(0.2);
  });

  it("filtra evidence_episode_ids inv\u00e1lidos (anti-hallucination)", async () => {
    const ids = [
      captureOld("p", "a", 48),
      captureOld("p", "b", 48),
      captureOld("p", "c", 48),
    ];

    const distillFn = vi.fn().mockResolvedValue([
      {
        gist: "memoria con un id inventado",
        evidence_episode_ids: [...ids, "01INVENTADO000000000000000"],
      },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);
  });

  it("los episodios que el LLM leyó y no citó quedan como ruido y no se vuelven a mandar", async () => {
    const ids = [
      captureOld("mix", "decidimos usar pnpm en todo el monorepo", 48),
      captureOld("mix", "porque npm duplicaba dependencias", 48),
      captureOld("mix", "jaja dale", 48),
    ];
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "Decisión: pnpm en el monorepo", evidence_episode_ids: [ids[0], ids[1]] },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.episodes_consolidated).toBe(3);
    expect(distillFn).toHaveBeenCalledTimes(1);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(pending.n).toBe(0);
    const stub = db
      .prepare("SELECT m.gist, m.salience FROM episodes e JOIN memories m ON m.id = e.consolidated_into WHERE e.id = ?")
      .get(ids[2]) as { gist: string; salience: number };
    expect(stub.gist).toMatch(/^\[noise\] 1 episodio/);
    expect(stub.salience).toBeLessThan(0.2);
  });

  it("una memoria sin evidencia válida no deja a todos los episodios como ruido por error", async () => {
    const ids = [captureOld("x", "uno con algo", 48), captureOld("x", "dos con algo", 48)];
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "inventada", evidence_episode_ids: ["01INVENTADO000000000000000"] },
      { gist: "real", evidence_episode_ids: [ids[0]] },
    ]);

    await runConsolidation(db, { minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {} });

    const gists = db
      .prepare("SELECT m.gist FROM episodes e JOIN memories m ON m.id = e.consolidated_into ORDER BY e.created_at, e.id")
      .all() as { gist: string }[];
    expect(gists.map((g) => g.gist).sort()).toEqual(["[noise] 1 episodio sin citar en esta tanda", "real"].sort());
  });

  it("si todo lo que devolvió el LLM es inventado, los episodios quedan pendientes", async () => {
    captureOld("y", "uno con algo", 48);
    captureOld("y", "dos con algo", 48);
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "inventada", evidence_episode_ids: ["01INVENTADO000000000000000"] },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {},
    });

    expect(summary.episodes_consolidated).toBe(0);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(pending.n).toBe(2);
  });

  it("dryRun no llama al LLM ni crea memorias", async () => {
    captureOld("d", "uno", 48);
    captureOld("d", "dos", 48);
    captureOld("d", "tres", 48);

    const distillFn = vi.fn();
    const summary = await runConsolidation(db, { dryRun: true, distillFn, log: () => {} });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.memories_created).toBe(0);
  });

  it("un error fatal del proveedor corta la corrida en vez de repetirse por cada ámbito", async () => {
    for (const scope of ["a", "b", "c"]) {
      for (const n of [1, 2, 3]) captureOld(scope, `decisión ${scope} ${n} sobre la arquitectura`, 48);
    }
    const distillFn = vi.fn().mockRejectedValue(new LlmFatalError("HTTP 402: sin saldo"));

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(summary.aborted).toBe(true);
    expect(summary.errors).toHaveLength(1);
  });

  it("arma tandas que entran en el presupuesto y vacía el ámbito en la misma corrida", async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => captureOld("grande", `${n} ${"x".repeat(30_000)}`, 48));
    const prompts: string[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      prompts.push(user);
      const batch = ids.filter((id) => user.includes(id));
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxPromptChars: 70_000,
      maxEpisodeChars: 40_000,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(prompts.map((p) => ids.filter((id) => p.includes(id)).length)).toEqual([2, 2, 1]);
    expect(prompts.every((p) => p.length < 70_000 + 2_000)).toBe(true);
    expect(summary.episodes_consolidated).toBe(5);
  });

  it("recorta un episodio enorme en vez de mandarlo entero", async () => {
    const ids = [captureOld("enorme", `inicio ${"y".repeat(100_000)} final`, 48)];
    ids.push(captureOld("enorme", "otro episodio con contenido", 48));
    let prompt = "";
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      prompt = user;
      return [{ gist: "resumen", evidence_episode_ids: ids }];
    });

    await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxEpisodeChars: 10_000,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain("inicio");
    expect(prompt).toContain("final");
    expect(prompt).toContain("[recortado]");
  });

  it("si la respuesta llega cortada, parte la tanda a la mitad y no pierde episodios", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => captureOld("charlas", `charla ${n} con decisiones`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = ids.filter((id) => user.includes(id));
      sizes.push(batch.length);
      if (batch.length > 2) throw new LlmTruncatedError("cortada");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(sizes).toEqual([8, 4, 2, 2, 2, 2]);
    expect(summary.episodes_consolidated).toBe(8);
    expect(summary.scopes_failed).toBe(0);
  });

  it("un JSON mal armado también parte la tanda en vez de perderla", async () => {
    const ids = [1, 2, 3, 4].map((n) => captureOld("json", `nota ${n} con decisiones`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = ids.filter((id) => user.includes(id));
      sizes.push(batch.length);
      if (batch.length > 2) throw new LlmInvalidJsonError("JSON inválido");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {},
    });

    expect(sizes).toEqual([4, 2, 2]);
    expect(summary.episodes_consolidated).toBe(4);
  });

  it("una respuesta cortada con un solo episodio es un error del ámbito, no un bucle", async () => {
    captureOld("uno", "episodio único larguísimo", 48);
    const distillFn = vi.fn().mockRejectedValue(new LlmTruncatedError("cortada"));

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(summary.scopes_failed).toBe(1);
  });

  it("un JSON inválido de un solo episodio queda como ruido y no traba el resto", async () => {
    const poison = captureOld("cola", "episodio con barras que rompen el JSON", 48);
    const ok = [
      captureOld("cola", "decidimos usar Zustand para el estado", 48),
      captureOld("cola", "porque Redux era overkill en este repo", 48),
    ];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      if (user.includes(poison)) throw new LlmInvalidJsonError("JSON inválido");
      const evidence = ok.filter((id) => user.includes(id));
      return [{ gist: "Zustand sobre Redux", evidence_episode_ids: evidence }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.scopes_failed).toBe(0);
    const pending = db
      .prepare("SELECT id FROM episodes WHERE consolidated_into IS NULL")
      .all() as { id: string }[];
    expect(pending.map((r) => r.id)).toEqual([]);
    const noise = db
      .prepare("SELECT gist FROM memories WHERE gist LIKE '[noise]%'")
      .get() as { gist: string };
    expect(noise.gist).toMatch(/1 episodio/);
  });

  it("respeta el tope de llamadas por corrida y deja el resto para la próxima", async () => {
    for (const scope of ["a", "b", "c"]) {
      for (const n of [1, 2, 3]) captureOld(scope, `nota ${scope} ${n} sobre el despliegue`, 48);
    }
    const distillFn = vi.fn().mockResolvedValue([]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxCalls: 2,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(2);
    expect(summary.llm_calls).toBe(2);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(pending.n).toBe(3);
  });

  it("Pareto pre-filter: episodios L0 cortos triviales se marcan como noise sin LLM", async () => {
    captureOld("trivial", "ok", 48);
    captureOld("trivial", "dale", 48);
    captureOld("trivial", "listo", 48);

    const distillFn = vi.fn();
    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: true,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    // Todos caen en L0 → no se llama al LLM, se crea 1 memoria stub
    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.episodes_dropped_pareto_l0).toBe(3);
    expect(summary.memories_created).toBe(1);
  });
});
