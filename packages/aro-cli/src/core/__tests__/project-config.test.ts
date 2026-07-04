import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectConfigError } from "../errors.js";
import { loadProjectConfig, parseProjectConfig, parseProjectConfigValue } from "../project-config.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-project-config-");
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

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
});

describe("loadProjectConfig", () => {
  it("project.yaml が無ければ PROJECT_CONFIG_NOT_FOUND", async () => {
    await expect(loadProjectConfig(repoRoot)).rejects.toMatchObject({ code: "PROJECT_CONFIG_NOT_FOUND" });
  });

  it("project.yaml を読み込み検証する", async () => {
    await writeRaw(
      repoRoot,
      ".ai/project.yaml",
      `schema_version: 1
project:
  name: demo
  risk_level: low
`,
    );
    const config = await loadProjectConfig(repoRoot);
    expect(config.project.risk_level).toBe("low");
  });

  it("schema 不一致（risk_level が enum 外）なら PROJECT_CONFIG_INVALID", async () => {
    await writeRaw(repoRoot, ".ai/project.yaml", "project:\n  risk_level: extreme\n");
    await expect(loadProjectConfig(repoRoot)).rejects.toMatchObject({ code: "PROJECT_CONFIG_INVALID" });
  });

  it("壊れた YAML なら PROJECT_CONFIG_PARSE", async () => {
    await writeRaw(repoRoot, ".ai/project.yaml", "project: [unterminated\n");
    await expect(loadProjectConfig(repoRoot)).rejects.toMatchObject({ code: "PROJECT_CONFIG_PARSE" });
  });
});
