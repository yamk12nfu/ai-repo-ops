import { describe, expect, it } from "vitest";

import { ProjectConfigError } from "../errors.js";
import {
  parseProjectConfig,
  parseProjectConfigValue,
  tryParseProjectName,
} from "../project-config.js";

describe("parseProjectConfigValue", () => {
  it("project.risk_level が enum 内なら成功し、ai 未設定でも通る", () => {
    const config = parseProjectConfigValue({ project: { risk_level: "high" } });
    expect(config.project.risk_level).toBe("high");
    expect(config.ai).toBeUndefined();
  });

  it("project.risk_level が enum 外なら PROJECT_CONFIG_INVALID", () => {
    try {
      parseProjectConfigValue({ project: { risk_level: "extreme" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect((error as ProjectConfigError).code).toBe("PROJECT_CONFIG_INVALID");
    }
  });

  it("project セクション自体が無ければ PROJECT_CONFIG_INVALID", () => {
    expect(() => parseProjectConfigValue({})).toThrowError(ProjectConfigError);
  });

  it("ai.max_changed_files が 0 以下なら PROJECT_CONFIG_INVALID", () => {
    expect(() =>
      parseProjectConfigValue({ project: { risk_level: "low" }, ai: { max_changed_files: 0 } }),
    ).toThrowError(ProjectConfigError);
  });

  it("project / ai 以外のフィールドは通す（passthrough）", () => {
    const config = parseProjectConfigValue({
      schema_version: 1,
      project: { name: "demo", type: "generic", risk_level: "medium", owner: "unknown" },
      commands: { lint: "eslint ." },
      quality_gates: { required: ["lint"] },
      review: { require_human_review: true },
      evals: {},
    });
    expect(config.project.risk_level).toBe("medium");
    expect(config.project.name).toBe("demo");
  });

  it("project.nameはoptional stringとして型検査する", () => {
    expect(parseProjectConfigValue({ project: { risk_level: "medium" } }).project.name).toBeUndefined();
    expect(() =>
      parseProjectConfigValue({ project: { name: 42, risk_level: "medium" } }),
    ).toThrowError(ProjectConfigError);
  });
});

describe("tryParseProjectName", () => {
  it("valid configからnameを返す", () => {
    expect(tryParseProjectName("project:\n  name: demo\n  risk_level: medium\n")).toBe("demo");
  });

  it.each([
    "project: [broken\n",
    "project:\n  risk_level: medium\n",
    "project:\n  name: demo\n  risk_level: extreme\n",
  ])("不正またはname無しならundefinedを返す", (yaml) => {
    expect(tryParseProjectName(yaml)).toBeUndefined();
  });
});

describe("parseProjectConfig", () => {
  it("壊れた YAML は PROJECT_CONFIG_PARSE", () => {
    try {
      parseProjectConfig("project:\n  risk_level: [unterminated\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect((error as ProjectConfigError).code).toBe("PROJECT_CONFIG_PARSE");
    }
  });

  it("project.yaml.hbs 相当の内容を parse できる", () => {
    const config = parseProjectConfig(`schema_version: 1
project:
  name: demo
  type: generic
  risk_level: medium
  owner: unknown
ai:
  max_loops: 4
  max_changed_files: 10
  allowed_paths:
    - "src/**"
    - "tests/**"
    - "docs/**"
  forbidden_paths:
    - ".env"
    - "secrets/**"
`);
    expect(config.project.risk_level).toBe("medium");
    expect(config.ai?.max_changed_files).toBe(10);
    expect(config.ai?.allowed_paths).toEqual(["src/**", "tests/**", "docs/**"]);
  });

  it("schema 不一致（risk_level が enum 外）なら PROJECT_CONFIG_INVALID", () => {
    try {
      parseProjectConfig("project:\n  risk_level: extreme\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect((error as ProjectConfigError).code).toBe("PROJECT_CONFIG_INVALID");
    }
  });
});
