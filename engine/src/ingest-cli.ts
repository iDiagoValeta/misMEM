#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultDbPath, openDefaultDb } from "./db.js";
import { walkAndIngest } from "./ingest/walk.js";
import { ingestChatGPTExport } from "./ingest/chatgpt.js";
import { ingestVSCodeTranscripts, ingestVSCodePrompts } from "./ingest/vscode.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseIngestArgs } from "./ingest-args.js";

const DB_PATH = defaultDbPath();

function help(): void {
  console.log(`misMEM ingest CLI
Usage:
  mismem-ingest walk <root> <scope-prefix>     Walk a directory tree.
  mismem-ingest file <path> <scope>            Ingest a single file.
  mismem-ingest chatgpt <export-root>          Parse conversations-*.json.
  mismem-ingest vscode <user-dir>              Transcripts + prompts.
  mismem-ingest stats                          Show DB stats.
  mismem-ingest help

DB: ${DB_PATH}  (override with MISMEM_DB)`);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseIngestArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[ingest] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  const { command } = parsed;
  if (command === "help") { help(); return; }

  const db = openDefaultDb();

  switch (parsed.command) {
    case "walk": {
      const s = await walkAndIngest({ root: resolve(parsed.root), scopePrefix: parsed.scopePrefix, db });
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "file": {
      const { readFile } = await import("node:fs/promises");
      const { capture } = await import("./tools.js");
      const content = await readFile(resolve(parsed.path), "utf8");
      const r = capture(db, { scope: parsed.scope, body: content });
      console.log(JSON.stringify(r));
      break;
    }
    case "chatgpt": {
      const s = await ingestChatGPTExport(db, resolve(parsed.root));
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "vscode": {
      const t = await ingestVSCodeTranscripts(db, resolve(parsed.userDir));
      const p = await ingestVSCodePrompts(db, resolve(parsed.userDir));
      console.log(JSON.stringify({ transcripts: t, prompts: p }, null, 2));
      break;
    }
    case "stats": {
      const ep = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
      const me = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
      const tr = db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number };
      const scopes = db.prepare(
        "SELECT scope, COUNT(*) AS n FROM episodes GROUP BY scope ORDER BY n DESC LIMIT 20"
      ).all();
      console.log(JSON.stringify({
        db: DB_PATH, episodes: ep.n, memories: me.n, traits: tr.n, top_scopes: scopes,
      }, null, 2));
      break;
    }
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
