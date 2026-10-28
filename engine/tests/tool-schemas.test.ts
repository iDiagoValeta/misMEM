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

// The MCP inputSchema is hand-written, Zod is what validates. This derives what each Zod
// field enforces and checks the advertised JSON schema says the same.
const ZOD: Record<string, z.ZodObject<z.ZodRawShape>> = {
  capture: CaptureInput,
  recall: RecallInput,
  reinforce: ReinforceInput,
  consolidate: ConsolidateInput,
  crystallize: CrystallizeInput,
  forget: ForgetInput,
};

interface Constraints {
  type: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  enum?: string[];
  items?: Constraints;
}

function derive(schema: z.ZodTypeAny): { optional: boolean; c: Constraints } {
  let optional = false;
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional) s = s.unwrap();
    else if (s instanceof z.ZodDefault) s = s._def.innerType;
    else break;
    optional = true;
  }
  if (s instanceof z.ZodString) {
    const c: Constraints = { type: "string" };
    for (const k of s._def.checks) {
      if (k.kind === "min") c.minLength = k.value;
      if (k.kind === "max") c.maxLength = k.value;
    }
    return { optional, c };
  }
  if (s instanceof z.ZodNumber) {
    const c: Constraints = { type: "number" };
    for (const k of s._def.checks) {
      if (k.kind === "int") c.type = "integer";
    }
    for (const k of s._def.checks) {
      // .positive() is an exclusive bound at 0: the smallest integer allowed is 1.
      if (k.kind === "min") c.minimum = k.inclusive ? k.value : c.type === "integer" ? k.value + 1 : undefined;
      if (k.kind === "max") c.maximum = k.value;
    }
    return { optional, c };
  }
  if (s instanceof z.ZodBoolean) return { optional, c: { type: "boolean" } };
  if (s instanceof z.ZodEnum) return { optional, c: { type: "string", enum: [...s.options] } };
  if (s instanceof z.ZodArray) {
    const c: Constraints = { type: "array", items: derive(s.element).c };
    if (s._def.minLength) c.minItems = s._def.minLength.value;
    if (s._def.maxLength) c.maxItems = s._def.maxLength.value;
    return { optional, c };
  }
  throw new Error(`unhandled zod type ${s.constructor.name}`);
}

function advertised(json: Record<string, unknown>): Constraints {
  const c: Constraints = { type: json.type as string };
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "enum"] as const) {
    if (json[key] !== undefined) (c as unknown as Record<string, unknown>)[key] = json[key];
  }
  if (json.items) c.items = advertised(json.items as Record<string, unknown>);
  return c;
}

function strip(c: Constraints): Constraints {
  return JSON.parse(JSON.stringify(c)) as Constraints; // drops undefined keys
}

describe("MCP inputSchema matches the Zod schema", () => {
  it("covers every canonical tool", () => {
    expect(CANONICAL_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(ZOD).sort());
  });

  for (const tool of CANONICAL_TOOLS) {
    it(`${tool.name}: same fields, required set and constraints`, () => {
      const shape = ZOD[tool.name]!.shape;
      const props = tool.inputSchema.properties as unknown as Record<string, Record<string, unknown>>;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];

      expect(Object.keys(props).sort()).toEqual(Object.keys(shape).sort());
      const mustHave = Object.entries(shape)
        .filter(([, v]) => !derive(v).optional)
        .map(([k]) => k);
      expect([...required].sort()).toEqual(mustHave.sort());
      for (const [key, zodField] of Object.entries(shape)) {
        expect(strip(advertised(props[key]!)), `${tool.name}.${key}`).toEqual(strip(derive(zodField).c));
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
