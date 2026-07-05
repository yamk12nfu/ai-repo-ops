import { describe, expect, it } from "vitest";

import { PolicyError } from "../errors.js";
import { parsePolicy, parsePolicyValue, policyPathForRiskLevel } from "../policy.js";

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

  it("risk_level ごとの実 policy 相当の内容（low/medium/high）を parse できる", () => {
    const low = parsePolicy("change_limits:\n  max_changed_files: 25\n  max_added_lines: 1000\n");
    expect(low.change_limits?.max_changed_files).toBe(25);

    const medium = parsePolicy(
      "change_limits:\n  max_changed_files: 10\n  max_added_lines: 400\nforbidden_paths:\n  - \"infra/prod/**\"\n",
    );
    expect(medium.change_limits?.max_changed_files).toBe(10);
    expect(medium.forbidden_paths).toEqual(["infra/prod/**"]);

    const high = parsePolicy("change_limits:\n  max_changed_files: 5\n  max_added_lines: 150\n");
    expect(high.change_limits?.max_changed_files).toBe(5);
  });

  it("schema 不一致（max_changed_files が負値）なら POLICY_INVALID", () => {
    try {
      parsePolicy("change_limits:\n  max_changed_files: -1\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).code).toBe("POLICY_INVALID");
    }
  });
});
