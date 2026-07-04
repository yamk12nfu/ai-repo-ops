import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PolicyError } from "../errors.js";
import { loadPolicy, parsePolicy, parsePolicyValue, policyPathForRiskLevel } from "../policy.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-policy-");
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("policyPathForRiskLevel", () => {
  it("low/medium/high それぞれの対応 path を返す", () => {
    expect(policyPathForRiskLevel("low")).toBe(".ai/managed/policies/low-risk.yaml");
    expect(policyPathForRiskLevel("medium")).toBe(".ai/managed/policies/default.yaml");
    expect(policyPathForRiskLevel("high")).toBe(".ai/managed/policies/security.yaml");
  });
});

describe("parsePolicyValue", () => {
  it("空オブジェクトでも成功する（change_limits / forbidden_paths ともに制限なし）", () => {
    const policy = parsePolicyValue({});
    expect(policy.change_limits).toBeUndefined();
    expect(policy.forbidden_paths).toBeUndefined();
  });

  it("change_limits.max_added_lines が負値なら POLICY_INVALID", () => {
    try {
      parsePolicyValue({ change_limits: { max_added_lines: -1 } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).code).toBe("POLICY_INVALID");
    }
  });

  it("change_limits.max_changed_files が 0 以下なら POLICY_INVALID", () => {
    expect(() => parsePolicyValue({ change_limits: { max_changed_files: 0 } })).toThrowError(PolicyError);
  });

  it("forbidden_paths が文字列配列でなければ POLICY_INVALID", () => {
    expect(() => parsePolicyValue({ forbidden_paths: [1, 2] })).toThrowError(PolicyError);
  });

  it("change_limits / forbidden_paths 以外のフィールドは通す（passthrough）", () => {
    const policy = parsePolicyValue({
      schema_version: 1,
      name: "default",
      description: "medium リスク向け",
      review: { require_human_review: true, block_on: ["failing_required_gates"] },
      allowed_actions: ["fix_bug"],
      quality_gates: { required: ["lint", "test"] },
      change_limits: { max_changed_files: 10, max_added_lines: 400 },
      forbidden_paths: [".env", "secrets/**"],
    });
    expect(policy.change_limits?.max_changed_files).toBe(10);
    expect(policy.forbidden_paths).toEqual([".env", "secrets/**"]);
  });
});

describe("parsePolicy", () => {
  it("壊れた YAML は POLICY_PARSE", () => {
    try {
      parsePolicy("change_limits: [unterminated\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).code).toBe("POLICY_PARSE");
    }
  });
});

describe("loadPolicy: risk_level ごとの実ファイル読み込み", () => {
  it("low → .ai/managed/policies/low-risk.yaml を読む", async () => {
    await writeRaw(
      repoRoot,
      ".ai/managed/policies/low-risk.yaml",
      "change_limits:\n  max_changed_files: 25\n  max_added_lines: 1000\n",
    );
    const policy = await loadPolicy(repoRoot, "low");
    expect(policy.change_limits?.max_changed_files).toBe(25);
    expect(policy.change_limits?.max_added_lines).toBe(1000);
  });

  it("medium → .ai/managed/policies/default.yaml を読む", async () => {
    await writeRaw(
      repoRoot,
      ".ai/managed/policies/default.yaml",
      "change_limits:\n  max_changed_files: 10\n  max_added_lines: 400\n",
    );
    const policy = await loadPolicy(repoRoot, "medium");
    expect(policy.change_limits?.max_changed_files).toBe(10);
    expect(policy.change_limits?.max_added_lines).toBe(400);
  });

  it("high → .ai/managed/policies/security.yaml を読む", async () => {
    await writeRaw(
      repoRoot,
      ".ai/managed/policies/security.yaml",
      "change_limits:\n  max_changed_files: 5\n  max_added_lines: 150\n",
    );
    const policy = await loadPolicy(repoRoot, "high");
    expect(policy.change_limits?.max_changed_files).toBe(5);
    expect(policy.change_limits?.max_added_lines).toBe(150);
  });

  it("対応する policy ファイルが無ければ POLICY_NOT_FOUND（risk_level ごとに異なる path）", async () => {
    await expect(loadPolicy(repoRoot, "low")).rejects.toMatchObject({ code: "POLICY_NOT_FOUND" });
    await expect(loadPolicy(repoRoot, "medium")).rejects.toMatchObject({ code: "POLICY_NOT_FOUND" });
    await expect(loadPolicy(repoRoot, "high")).rejects.toMatchObject({ code: "POLICY_NOT_FOUND" });
  });

  it("schema 不一致（max_changed_files が負値）なら POLICY_INVALID", async () => {
    await writeRaw(repoRoot, ".ai/managed/policies/default.yaml", "change_limits:\n  max_changed_files: -1\n");
    await expect(loadPolicy(repoRoot, "medium")).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  it("壊れた YAML なら POLICY_PARSE", async () => {
    await writeRaw(repoRoot, ".ai/managed/policies/security.yaml", "change_limits: [unterminated\n");
    await expect(loadPolicy(repoRoot, "high")).rejects.toMatchObject({ code: "POLICY_PARSE" });
  });
});
