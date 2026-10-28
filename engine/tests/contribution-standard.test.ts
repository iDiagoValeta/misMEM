import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// The labels the contribution standard names live in several files that nothing else
// links: issue forms, PR templates, release.yml and CONTRIBUTING.md. A label cited in one
// and missing from .github/labels.json is dropped silently by GitHub (the issue lands
// unlabelled), so the check is mechanical instead of a review chore. The other half, that
// labels.json matches what GitHub holds, needs the API and lives in workflows/labels.yml.

const ROOT = new URL("../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(new URL(relative, ROOT), "utf8");
}

interface Label {
  name: string;
  kind: string;
}

const labels = (JSON.parse(read(".github/labels.json")) as { labels: Label[] }).labels;
const declared = new Set(labels.map((l) => l.name));
const typeLabels = labels.filter((l) => l.kind === "type").map((l) => l.name);
// Anything that is part of the standard; github-default entries are inventory only.
const standardLabels = labels.filter((l) => l.kind !== "github-default").map((l) => l.name);

// Type labels with no issue form, and why. Adding to this list is a decision: a type label
// nobody can pick from a form is one the triager applies by hand.
const FORMLESS: Record<string, string> = {
  dependencies: "opened by Dependabot, never by a person",
  security: "reported privately through the contact link in config.yml, never as a public issue",
  cleanup: "triage swaps it onto the enhancement form",
  research: "triage swaps it onto the enhancement form",
};

const BEGIN = "<!-- labels:begin -->";
const END = "<!-- labels:end -->";
const BACKTICKED = /`([^`]+)`/g;
const HTML_COMMENT = /<!--.*?-->/gs;
// `labels: ["bug"]` or `labels: [wontfix, duplicate]`: one line, flow style.
const FLOW_LABELS = /^\s*labels:\s*\[(.*)\]\s*$/gm;
const BLOCK_LABELS = /^\s*labels:\s*$/m;

function flowLabels(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(FLOW_LABELS)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().replace(/^["']|["']$/g, "");
      if (name && name !== "*") found.push(name);
    }
  }
  return found;
}

function blockLabels(text: string): string[] {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || start > end) return [];
  const block = text.slice(start + BEGIN.length, end).replace(HTML_COMMENT, "");
  return [...block.matchAll(BACKTICKED)].map((m) => m[1] ?? "");
}

function files(dir: string, ext: string): string[] {
  return readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith(ext)).sort();
}

const forms = files(".github/ISSUE_TEMPLATE/", ".yml").filter((f) => f !== "config.yml");
const prTemplates = files(".github/PULL_REQUEST_TEMPLATE/", ".md");
// The templates that tell the author which labels to set; release.md sets none.
const prWithLabels = ["dependency.md", "documentation.md"];

function undeclared(names: string[]): string[] {
  return [...new Set(names)].filter((n) => !declared.has(n)).sort();
}

describe("labels.json", () => {
  it("has unique names and the kinds the standard knows", () => {
    expect(new Set(labels.map((l) => l.name)).size).toBe(labels.length);
    const kinds = new Set(["type", "modifier", "area", "priority", "github-default"]);
    expect(labels.filter((l) => !kinds.has(l.kind)).map((l) => l.name)).toEqual([]);
  });
});

describe("issue forms", () => {
  it("exist, and each one sets its labels in flow style", () => {
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      const text = read(`.github/ISSUE_TEMPLATE/${form}`);
      expect(BLOCK_LABELS.test(text), `${form}: write labels on one line, as [a, b]`).toBe(false);
      expect(flowLabels(text).length, `${form}: no labels line`).toBeGreaterThan(0);
    }
  });

  it("only assign declared labels", () => {
    for (const form of forms) {
      const text = read(`.github/ISSUE_TEMPLATE/${form}`);
      expect(undeclared(flowLabels(text)), `${form} assigns undeclared labels`).toEqual([]);
    }
  });

  it("cover every type label, or list it as form-less with a reason", () => {
    const covered = new Set(forms.flatMap((f) => flowLabels(read(`.github/ISSUE_TEMPLATE/${f}`))));
    const missing = typeLabels.filter((l) => !covered.has(l) && !(l in FORMLESS));
    expect(missing, "type labels with neither a form nor a FORMLESS entry").toEqual([]);
    const stale = Object.keys(FORMLESS).filter((l) => !typeLabels.includes(l) || covered.has(l));
    expect(stale, "FORMLESS entries that are not type labels or do have a form").toEqual([]);
  });
});

describe("release.yml", () => {
  const text = read(".github/release.yml");

  it("cites only declared labels, in flow style", () => {
    expect(BLOCK_LABELS.test(text), "write labels on one line, as [a, b]").toBe(false);
    const cited = flowLabels(text);
    expect(cited.length).toBeGreaterThan(0);
    expect(undeclared(cited)).toEqual([]);
  });
});

describe("PR templates", () => {
  it("exist for the default flow and for each special one", () => {
    expect(prTemplates).toEqual(["dependency.md", "documentation.md", "release.md"]);
  });

  it("cite only declared labels in their delimited block", () => {
    for (const name of prWithLabels) {
      const cited = blockLabels(read(`.github/PULL_REQUEST_TEMPLATE/${name}`));
      expect(cited.length, `${name}: no label block`).toBeGreaterThan(0);
      expect(undeclared(cited), `${name} cites undeclared labels`).toEqual([]);
    }
    const main = blockLabels(read(".github/pull_request_template.md"));
    expect(main.length, "pull_request_template.md: no label block").toBeGreaterThan(0);
    expect(undeclared(main)).toEqual([]);
  });
});

describe("CONTRIBUTING.md", () => {
  const text = read("CONTRIBUTING.md");
  const cited = blockLabels(text);

  it("still carries the delimited label block, or this check would read nothing", () => {
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    expect(cited.length).toBeGreaterThan(0);
  });

  it("names only declared labels", () => {
    expect(undeclared(cited)).toEqual([]);
  });

  it("names every label that is part of the standard", () => {
    expect(standardLabels.filter((l) => !cited.includes(l))).toEqual([]);
  });
});
