#!/usr/bin/env node
/**
 * mismem-embed — backfill y reindexado de embeddings para memories.
 *
 * Requiere el servidor de embeddings configurado: Ollama (default:
 * `ollama pull nomic-embed-text`) o uno compatible con OpenAI. Idempotente: procesa vectores
 * ausentes u obsoletos; `--force` reconstruye también los compatibles.
 *
 * Uso:
 *   mismem-embed [--scope <name>] [--batch 32] [--status] [--force]
 */
import { defaultDbPath, openDefaultDb } from "./db.js";
import {
  embedPendingMemories,
  getEmbeddingIndexStatus,
  loadEmbeddingConfig,
} from "./embeddings/index.js";

interface Args {
  scope?: string;
  batch: number;
  status: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { batch: 32, status: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scope":
        args.scope = argv[++i];
        break;
      case "--batch":
        args.batch = Number(argv[++i]) || 32;
        break;
      case "--stats":
      case "--status":
        args.status = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "mismem-embed [--scope <name>] [--batch 32] [--status] [--force]\n" +
            `DB: ${defaultDbPath()} (override con MISMEM_DB)\n` +
            "Env: MISMEM_EMBEDDING_PROVIDER (ollama|openai), MISMEM_EMBEDDING_URL o MISMEM_OLLAMA_URL,\n" +
            "     MISMEM_EMBEDDING_MODEL, MISMEM_EMBEDDING_QUERY_PREFIX, MISMEM_EMBEDDING_DOC_PREFIX,\n" +
            "     MISMEM_EMBEDDING_MIN_SCORE, MISMEM_EMBEDDING_MAX_CHARS, MISMEM_EMBEDDING_TIMEOUT_MS,\n" +
            "     MISMEM_EMBEDDINGS=off\n" +
            "Cambiar de modelo se detecta solo; cambiar un prefijo o MAX_CHARS no: reindexar con --force.",
        );
        process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDefaultDb();
  try {
    const cfg = loadEmbeddingConfig();
    const status = getEmbeddingIndexStatus(db, cfg.model);

    if (args.status) {
      console.log(
        JSON.stringify(
          { db: defaultDbPath(), active_model: cfg.model, ...status },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `[embed] modelo=${cfg.model} ${cfg.provider}=${cfg.url} memorias=${status.memories} embebidas=${status.embedded}`,
    );
    const result = await embedPendingMemories(db, {
      scope: args.scope,
      batchSize: args.batch,
      timeoutMs: 120_000,
      force: args.force,
    });
    console.log(
      `[embed] pendientes=${result.pending} embebidas=${result.embedded} reembebidas=${result.reembedded} fallidas=${result.failed}`,
    );
    if (result.failed > 0 && result.embedded === 0) {
      console.error(
        cfg.provider === "openai"
          ? `[embed] ¿El servidor de embeddings está corriendo? Probá: curl ${cfg.url}/health`
          : `[embed] ¿Ollama está corriendo? Probá: curl ${cfg.url}/api/tags — y \`ollama pull ${cfg.model}\``,
      );
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
