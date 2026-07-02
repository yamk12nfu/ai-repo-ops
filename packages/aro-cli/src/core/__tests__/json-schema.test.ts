import { describe, expect, it } from "vitest";

import { validateJsonSchema } from "../json-schema.js";

describe("validateJsonSchema: type", () => {
  it("type が一致すれば valid", () => {
    expect(validateJsonSchema({ type: "string" }, "hello")).toEqual([]);
    expect(validateJsonSchema({ type: "integer" }, 42)).toEqual([]);
    expect(validateJsonSchema({ type: "object" }, {})).toEqual([]);
    expect(validateJsonSchema({ type: "array" }, [])).toEqual([]);
    expect(validateJsonSchema({ type: "boolean" }, true)).toEqual([]);
    expect(validateJsonSchema({ type: "null" }, null)).toEqual([]);
  });

  it("type が不一致なら issue を返す", () => {
    const issues = validateJsonSchema({ type: "string" }, 42);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("$");
  });

  it("integer は非整数の number を拒否する", () => {
    expect(validateJsonSchema({ type: "integer" }, 1.5)).toHaveLength(1);
  });

  it("type が配列（union）なら、いずれかに一致すれば valid", () => {
    expect(validateJsonSchema({ type: ["string", "null"] }, null)).toEqual([]);
    expect(validateJsonSchema({ type: ["string", "null"] }, "x")).toEqual([]);
    expect(validateJsonSchema({ type: ["string", "null"] }, 1)).toHaveLength(1);
  });
});

describe("validateJsonSchema: enum / const", () => {
  it("enum に含まれれば valid、含まれなければ issue", () => {
    const schema = { enum: ["low", "medium", "high"] };
    expect(validateJsonSchema(schema, "medium")).toEqual([]);
    expect(validateJsonSchema(schema, "extreme")).toHaveLength(1);
  });

  it("const と一致しなければ issue", () => {
    expect(validateJsonSchema({ const: 1 }, 1)).toEqual([]);
    expect(validateJsonSchema({ const: 1 }, 2)).toHaveLength(1);
  });
});

describe("validateJsonSchema: required / properties / additionalProperties", () => {
  const schema = {
    type: "object",
    required: ["name", "risk_level"],
    properties: {
      name: { type: "string", minLength: 1 },
      risk_level: { type: "string", enum: ["low", "medium", "high"] },
    },
    additionalProperties: false,
  };

  it("必須キーが揃い additionalProperties も無ければ valid", () => {
    expect(validateJsonSchema(schema, { name: "demo", risk_level: "medium" })).toEqual([]);
  });

  it("必須キー欠落は issue（path にキー名を含む）", () => {
    const issues = validateJsonSchema(schema, { name: "demo" });
    expect(issues.some((i) => i.path === "$.risk_level" && i.message === "is required")).toBe(true);
  });

  it("additionalProperties: false のとき未知キーは issue", () => {
    const issues = validateJsonSchema(schema, { name: "demo", risk_level: "low", extra: 1 });
    expect(issues.some((i) => i.path === "$.extra")).toBe(true);
  });

  it("additionalProperties がスキーマなら未知キーもそのスキーマで検証される", () => {
    const commandsSchema = { type: "object", additionalProperties: { type: "string" } };
    expect(validateJsonSchema(commandsSchema, { lint: "eslint .", test: "" })).toEqual([]);
    expect(validateJsonSchema(commandsSchema, { lint: 123 })).toHaveLength(1);
  });

  it("ネストした properties も再帰的に検証される", () => {
    const nested = {
      type: "object",
      properties: { project: schema },
    };
    const issues = validateJsonSchema(nested, { project: { name: "demo" } });
    expect(issues.some((i) => i.path === "$.project.risk_level")).toBe(true);
  });
});

describe("validateJsonSchema: items / minLength / minimum", () => {
  it("array の各要素を items スキーマで検証する", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(validateJsonSchema(schema, ["a", "b"])).toEqual([]);
    const issues = validateJsonSchema(schema, ["a", 1]);
    expect(issues.some((i) => i.path === "$[1]")).toBe(true);
  });

  it("minLength 未満の文字列は issue", () => {
    expect(validateJsonSchema({ type: "string", minLength: 1 }, "")).toHaveLength(1);
    expect(validateJsonSchema({ type: "string", minLength: 1 }, "x")).toEqual([]);
  });

  it("minimum 未満の数値は issue", () => {
    expect(validateJsonSchema({ type: "integer", minimum: 1 }, 0)).toHaveLength(1);
    expect(validateJsonSchema({ type: "integer", minimum: 1 }, 1)).toEqual([]);
  });
});

describe("validateJsonSchema: project.schema.json 相当の統合ケース", () => {
  const PROJECT_SCHEMA = {
    type: "object",
    required: ["schema_version", "project", "commands", "quality_gates", "ai"],
    properties: {
      schema_version: { const: 1 },
      project: {
        type: "object",
        required: ["name", "type", "risk_level"],
        properties: {
          name: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          risk_level: { type: "string", enum: ["low", "medium", "high"] },
          owner: { type: "string" },
        },
      },
      runtime: {
        type: "object",
        properties: { devcontainer: { type: ["string", "null"] } },
      },
      commands: {
        type: "object",
        properties: {
          setup: { type: "string" },
          lint: { type: "string" },
          typecheck: { type: "string" },
          test: { type: "string" },
          build: { type: "string" },
        },
        additionalProperties: { type: "string" },
      },
      quality_gates: {
        type: "object",
        properties: { required: { type: "array", items: { type: "string", minLength: 1 } } },
      },
      ai: {
        type: "object",
        properties: {
          max_loops: { type: "integer", minimum: 1 },
          max_changed_files: { type: "integer", minimum: 1 },
          allowed_paths: { type: "array", items: { type: "string", minLength: 1 } },
          forbidden_paths: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
      review: {
        type: "object",
        properties: {
          create_pr: { type: "boolean" },
          require_human_review: { type: "boolean" },
          auto_merge: { type: "boolean" },
        },
      },
      evals: { type: "object" },
    },
  };

  it("計画 §12 の初期テンプレート相当の値は valid", () => {
    const value = {
      schema_version: 1,
      project: { name: "demo-repo", type: "generic", risk_level: "medium", owner: "unknown" },
      runtime: { devcontainer: null },
      commands: { setup: "", lint: "", typecheck: "", test: "", build: "" },
      quality_gates: { required: ["lint", "test"] },
      ai: {
        max_loops: 4,
        max_changed_files: 10,
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
      },
      review: { create_pr: true, require_human_review: true, auto_merge: false },
      evals: {},
    };
    expect(validateJsonSchema(PROJECT_SCHEMA, value)).toEqual([]);
  });

  it("risk_level が enum 外なら issue", () => {
    const value = {
      schema_version: 1,
      project: { name: "demo", type: "generic", risk_level: "extreme" },
      commands: {},
      quality_gates: {},
      ai: {},
    };
    const issues = validateJsonSchema(PROJECT_SCHEMA, value);
    expect(issues.some((i) => i.path === "$.project.risk_level")).toBe(true);
  });

  it("必須トップレベルキー欠落は issue", () => {
    const issues = validateJsonSchema(PROJECT_SCHEMA, { schema_version: 1 });
    expect(issues.some((i) => i.path === "$.project")).toBe(true);
    expect(issues.some((i) => i.path === "$.commands")).toBe(true);
  });
});
