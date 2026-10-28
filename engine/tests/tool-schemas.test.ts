import { describe, it, expect } from "vitest";
import { z } from "zod";
import { CANONICAL_TOOLS } from "../src/server-core.js";
import {
  CaptureInput,
  ConsolidateInput,
  CrystallizeInput,
  ForgetInput,
  RecallInput,
  ReinforceInput,
} from "../src/schema.js";

// The MCP inputSchema is hand-written, Zod is what validates. Zod generates the JSON schema
// it enforces and this checks the advertised one says the same.
const ZOD: Record<string, z.ZodType> = {
  capture: CaptureInput,
  recall: RecallInput,
  reinforce: ReinforceInput,
  consolidate: ConsolidateInput,
  crystallize: CrystallizeInput,
  forget: ForgetInput,
};

type Json = Record<string, unknown>;

const KEYS = ["type", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "enum"] as const;

// Only the constraints that matter to a caller, in one canonical form for both sides.
// Zod expresses .positive() as exclusiveMinimum 0 and .int() as safe-integer bounds,
// while the hand-written schema says minimum 1; the safe-integer ceiling is advertised as is,
// so a caller is never told that a value Zod rejects is valid.
function constraints(json: Json): Json {
  const c: Json = {};
  for (const key of KEYS) if (json[key] !== undefined) c[key] = json[key];
  if (c.type === "integer") {
    if (typeof json.exclusiveMinimum === "number") c.minimum = json.exclusiveMinimum + 1;
    if (c.minimum === Number.MIN_SAFE_INTEGER) delete c.minimum;
  } else if (json.exclusiveMinimum !== undefined) {
    throw new Error("exclusiveMinimum on a non-integer is not comparable to the advertised schema");
  }
  if (json.items) c.items = constraints(json.items as Json);
  return c;
}

// io "input" is what a caller sends: fields with a .default() are optional there.
function generated(name: string): { properties: Record<string, Json>; required: string[] } {
  const json = z.toJSONSchema(ZOD[name]!, { io: "input" }) as { properties: Record<string, Json>; required?: string[] };
  return { properties: json.properties, required: json.required ?? [] };
}

describe("MCP inputSchema matches the Zod schema", () => {
  it("covers every canonical tool", () => {
    expect(CANONICAL_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(ZOD).sort());
  });

  for (const tool of CANONICAL_TOOLS) {
    it(`${tool.name}: same fields, required set and constraints`, () => {
      const zod = generated(tool.name);
      const props = tool.inputSchema.properties as unknown as Record<string, Json>;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];

      expect(Object.keys(props).sort()).toEqual(Object.keys(zod.properties).sort());
      expect([...required].sort()).toEqual([...zod.required].sort());
      for (const [key, field] of Object.entries(zod.properties)) {
        expect(constraints(props[key]!), `${tool.name}.${key}`).toEqual(constraints(field));
      }
    });
  }

  it("the arrays that Zod requires non-empty advertise minItems: 1", () => {
    const props = (name: string): Record<string, Record<string, unknown>> =>
      CANONICAL_TOOLS.find((t) => t.name === name)!.inputSchema.properties as unknown as Record<
        string,
        Record<string, unknown>
      >;
    expect(props("consolidate").source_episode_ids?.minItems).toBe(1);
    expect(props("crystallize").evidence_memory_ids?.minItems).toBe(1);
    expect(props("reinforce").memory_ids?.minItems).toBe(1);
  });
});
