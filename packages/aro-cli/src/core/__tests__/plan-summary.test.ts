import { describe, expect, it } from "vitest";

import { planHasContentDrift, planHasFileChanges, planRequiresSync } from "../plan-summary.js";
import type { ChangeKind, SyncPlan } from "../../types/plan.js";

/**
 * plan-summary は diff の exit code（diff.ts）と人間向け出力（diff-format.ts）が共有する
 * 「actionable」判定の単一の正。ここがずれると「出力は変更あり・exit は差分なし」の矛盾が
 * 起きるため、判定の境界（file change / content drift / orphaned・conflict の除外）を固定する。
 */

/** 判定に関与するフィールドだけ差し替えられる合成 plan。既定は「lock 一致・変更なし」。 */
function makePlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    repoRoot: "/repo",
    distribution: "base",
    currentVersion: "0.1.0",
    targetVersion: "0.1.0",
    currentDistributionSha256: "a".repeat(64),
    targetDistributionSha256: "a".repeat(64),
    versionUnchangedButContentChanged: false,
    hasConflicts: false,
    warnings: [],
    changes: [],
    ...overrides,
  };
}

/** 指定 kind の変更 1 件だけを持つ plan。 */
function planWithKind(kind: ChangeKind): SyncPlan {
  return makePlan({ changes: [{ kind, path: ".ai/managed/prompts/review.md" }] });
}

describe("planHasFileChanges", () => {
  it.each(["create", "update", "append_unique_lines"] as const)(
    "%s は実ファイル書き込みとして true",
    (kind) => {
      expect(planHasFileChanges(planWithKind(kind))).toBe(true);
    },
  );

  it.each(["preserve", "orphaned", "conflict", "noop"] as const)(
    "%s は実ファイル書き込みではないので false",
    (kind) => {
      expect(planHasFileChanges(planWithKind(kind))).toBe(false);
    },
  );

  it("changes が空なら false", () => {
    expect(planHasFileChanges(makePlan())).toBe(false);
  });

  it("noop の中に 1 件でも file change があれば true", () => {
    const plan = makePlan({
      changes: [
        { kind: "noop", path: ".ai/managed/prompts/review.md" },
        { kind: "update", path: ".ai/managed/policies/default.yaml" },
      ],
    });
    expect(planHasFileChanges(plan)).toBe(true);
  });
});

describe("planHasContentDrift", () => {
  it("lock と source の content sha が一致していれば false", () => {
    expect(planHasContentDrift(makePlan())).toBe(false);
  });

  it("lock と source の content sha が異なれば true（§10.5）", () => {
    expect(planHasContentDrift(makePlan({ targetDistributionSha256: "b".repeat(64) }))).toBe(true);
  });

  it("未 init（lock 無し = null）は drift ではなく false", () => {
    expect(planHasContentDrift(makePlan({ currentDistributionSha256: null }))).toBe(false);
  });
});

describe("planRequiresSync", () => {
  it("file change も drift も無ければ false（up to date）", () => {
    expect(planRequiresSync(planWithKind("noop"))).toBe(false);
  });

  it("file change があれば drift 無しでも true", () => {
    expect(planRequiresSync(planWithKind("create"))).toBe(true);
  });

  it("drift のみ（create_only 温存で実ファイル書き込み無し）でも true（§10.6）", () => {
    const plan = makePlan({
      targetDistributionSha256: "b".repeat(64),
      changes: [{ kind: "preserve", path: ".ai/project.yaml" }],
    });
    expect(planHasFileChanges(plan)).toBe(false);
    expect(planRequiresSync(plan)).toBe(true);
  });

  it("orphaned のみは WARN であって適用対象ではないので false（§16.4）", () => {
    expect(planRequiresSync(planWithKind("orphaned"))).toBe(false);
  });

  it("conflict のみは abort 要因として別経路で扱うため false", () => {
    const plan = makePlan({
      hasConflicts: true,
      changes: [{ kind: "conflict", path: ".ai/managed/prompts/review.md" }],
    });
    expect(planRequiresSync(plan)).toBe(false);
  });
});
