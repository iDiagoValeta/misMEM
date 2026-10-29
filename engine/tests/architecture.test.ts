import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// engine/src used to be flat. It is now grouped by capability, and the point of
// grouping is lost unless the dependencies stay one-way. The checks below are the
// contract: a review cannot see an import that skips a layer, and no other test
// fails when one appears. The rules that need one keep an explicit exception list, and
// the test fails when a new violation lands and when an exception outlives its cause.
// The layer rule has none left: `memory` no longer reaches back into `recall`.

const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ENGINE, "src");
const UI = join(ENGINE, "ui", "src");

// A level-0 file is part of the delivery or an entrypoint, so the list is exact:
// a new root file has to be placed in a capability or added here on purpose.
const ROOT_FILES = [
  "bench-args.ts",
  "bench-cli.ts",
  "cli-args.ts",
  "consolidate-args.ts",
  "consolidate-cli.ts",
  "embed-args.ts",
  "embed-cli.ts",
  "env.ts",
  "forget-args.ts",
  "forget-cli.ts",
  "ingest-args.ts",
  "ingest-cli.ts",
  "inject-cli.ts",
  "migrate-engram-args.ts",
  "migrate-engram-cli.ts",
  "obsidian-cli.ts",
  "schema.ts",
  "server-core.ts",
  "server-http.ts",
  "server.ts",
  "stats-args.ts",
  "stats-cli.ts",
  "used-cli.ts",
  "viewer-static.ts",
];

// Root files every layer may import: environment reading, argument parsing and
// the Zod boundary are shared vocabulary, not a capability.
const ROOT_LEAVES = new Set(["env.ts", "cli-args.ts", "schema.ts"]);

// Layers a capability may depend on, on top of itself and the root leaves.
const ALLOWED: Record<string, string[]> = {
  domain: [],
  store: ["domain"],
  embeddings: ["domain", "store"],
  memory: ["domain", "store", "embeddings"],
  recall: ["domain", "store", "embeddings", "memory"],
  queries: ["domain", "store", "embeddings", "memory"],
  consolidation: ["domain", "store", "embeddings", "memory", "recall"],
  ingest: ["domain", "store", "memory"],
  export: ["domain", "store", "queries", "memory"],
  hooks: ["domain", "store", "memory", "recall"],
  mcp: ["domain", "store", "embeddings", "memory", "recall", "queries"],
  http: ["domain", "store", "embeddings", "memory", "recall", "queries", "consolidation"],
};

// SQL belongs to the capabilities that own the schema. The delivery layer (root,
// http, mcp, hooks, export) only composes, so its queries are debt from the flat
// layout and each entry moves when its module is split.
const SQL_EXCEPTIONS: Record<string, string> = {
  "src/ingest-cli.ts (sql)": "reads stats inline; moves with the ingest split",
  "src/migrate-engram-cli.ts (sql)": "reads the engram database; moves with the ingest split",
  "src/obsidian-cli.ts (sql)": "opens the database itself; moves with the export split",
  "src/stats-cli.ts (sql)": "reads stats inline; moves with the query split",
  "src/export/obsidian.ts (sql)": "queries its own rows; moves with the export split",
  "src/http/viewer/read.ts (sql)": "read model of the viewer; moves with the query split",
  "src/http/viewer/api.ts (sql)": "read model of the viewer; moves with the query split",
  "src/http/viewer/actions.ts (sql)": "writes from the viewer; moves with the memory split",
  "src/mcp/engram-compat.ts (sql)": "legacy aliases with their own SQL; moves with the alias split",
};

// Ratchet: these already exceed 400 lines and are split in later PRs. Entries can
// only be removed; nothing new may be added.
const SIZE_EXCEPTIONS: Record<string, string> = {
  "src/consolidation/run.ts (400 líneas)": "awaits the consolidation split",
  "src/export/obsidian.ts (400 líneas)": "awaits the export split",
};

const MAX_LINES = 400;

function walk(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

// Comments carry examples (`from "./x.js"`, `.prepare(`), and matching those would
// report imports that do not exist. Scanning characters keeps strings intact, which
// a pair of regexes does not.
function stripComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += char;
    }
  }
  return out;
}

// Every way a module can pull another one in: `from`, a bare side-effect `import`,
// a dynamic `import()` and `require()`, with either quote style.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function specifiers(code: string): string[] {
  return [...code.matchAll(SPECIFIER)].map((m) => m[1] ?? "");
}

function sources(): { file: string; rel: string; code: string; raw: string }[] {
  return walk(SRC, [".ts", ".tsx"]).map((file) => {
    const raw = readFileSync(file, "utf8");
    return { file, rel: file.slice(ENGINE.length).split(sep).join("/"), code: stripComments(raw), raw };
  });
}

function target(srcFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const resolved = resolve(dirname(srcFile), spec);
  if (resolved !== SRC && !resolved.startsWith(SRC + sep)) return null;
  return relative(SRC, resolved).split(sep).join("/");
}

function layerOf(rel: string): string {
  const parts = rel.split("/");
  return parts.length === 1 ? "" : (parts[0] ?? "");
}

describe("estructura de src", () => {
  const files = sources();

  it("la raíz de src tiene exactamente los ficheros esperados", () => {
    const root = files.filter((f) => !f.rel.slice("src/".length).includes("/")).map((f) => f.rel.slice("src/".length));
    expect(root.sort()).toEqual([...ROOT_FILES].sort());
  });

  it("cada capa importa sólo las capas que tiene permitidas", () => {
    const violations: string[] = [];
    for (const { file, rel, code } of files) {
      const from = layerOf(rel.slice("src/".length));
      for (const spec of specifiers(code)) {
        const to = target(file, spec);
        if (!to) continue;
        const toLayer = layerOf(to);
        const allowed =
          from === "" ||
          toLayer === from ||
          (toLayer === "" && ROOT_LEAVES.has(to.replace(/\.js$/, ".ts"))) ||
          (ALLOWED[from] ?? []).includes(toLayer);
        if (!allowed) violations.push(`${rel} -> src/${to.replace(/\.js$/, ".ts")} (capa)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("domain no hace I/O ni lee el entorno", () => {
    const banned = /^(node:(fs|http|https|net|path|child_process|worker_threads)|better-sqlite3)$/;
    const violations: string[] = [];
    for (const { rel, code } of files) {
      if (layerOf(rel.slice("src/".length)) !== "domain") continue;
      if (specifiers(code).some((spec) => banned.test(spec)) || /\bprocess\.env\b/.test(code)) {
        violations.push(`${rel} (dominio puro)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("la capa de entrega no ejecuta SQL", () => {
    const delivery = new Set(["", "http", "mcp", "hooks", "export"]);
    const SQL = /\.(prepare|pragma|transaction)\(|\bdb\.exec\(/;
    const VALUE_IMPORT = /import\s+(?!type\b)[^;]*?from\s*"better-sqlite3"/;
    const violations: string[] = [];
    for (const { rel, code } of files) {
      const layer = layerOf(rel.slice("src/".length));
      if (!delivery.has(layer)) continue;
      if (SQL.test(code) || VALUE_IMPORT.test(code)) violations.push(`${rel} (sql)`);
    }
    expect(violations.filter((v) => !(v in SQL_EXCEPTIONS))).toEqual([]);
    expect(Object.keys(SQL_EXCEPTIONS).filter((k) => !violations.includes(k))).toEqual([]);
  });

  it("ningún fichero pasa del tope de líneas salvo las excepciones", () => {
    const files = [...walk(SRC, [".ts", ".tsx"]), ...walk(UI, [".ts", ".tsx"])];
    const violations = files
      .filter((file) => !file.includes(`${sep}components${sep}ui${sep}`))
      .map((file) => ({ file, lines: readFileSync(file, "utf8").replace(/\n$/, "").split("\n").length }))
      .filter(({ lines }) => lines > MAX_LINES)
      .map(({ file }) => `${file.slice(ENGINE.length).split(sep).join("/")} (${MAX_LINES} líneas)`);
    expect(violations.filter((v) => !(v in SIZE_EXCEPTIONS))).toEqual([]);
    expect(Object.keys(SIZE_EXCEPTIONS).filter((k) => !violations.includes(k))).toEqual([]);
  });
});
