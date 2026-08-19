import { describe, expect, it } from "vitest";

import * as executionPlanPromotion from "../execution-plan-promotion.js";
import {
  executionPlanTransitionFindings,
  type ExecutionPlanTransition,
} from "../execution-plan-promotion.js";
import type { ExecutionPlan } from "../execution-plans.js";

function plan(status: ExecutionPlan["status"], stageStatus: ExecutionPlan["stages"][number]["status"]): ExecutionPlan {
  return {
    schema_version: 1,
    id: "runtime",
    status,
    ...(status === "active" || status === "blocked"
      ? { current_stage: "stage-1" }
      : {}),
    ...(status === "active" ? { next_action: { id: "run-stage-1" } } : {}),
    updated_at: "2026-08-19",
    proposals: [],
    permissions: { commit: false, push: false, draft_pr: false, merge: false },
    stages: [{ id: "stage-1", status: stageStatus }],
  };
}

function transition(base: ExecutionPlan, head: ExecutionPlan): ExecutionPlanTransition {
  return {
    path: ".ai/local/execution-plans/runtime.md",
    base: { kind: "plan", plan: base },
    head: { kind: "plan", plan: head },
  };
}

function findingIds(base: ExecutionPlan, head: ExecutionPlan): string[] { return executionPlanTransitionFindings(transition(base, head)).map(({ id }) => id); }

describe("executionPlanTransitionFindings", () => {
  it("Planの blocked → active を promotion finding として返す", () => {
    const findings = executionPlanTransitionFindings(
      transition(plan("blocked", "blocked"), plan("active", "active")),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      "plan.status.blocked-to-active",
      "stage.status.blocked-to-active:stage-1",
    ]);
  });
  it("Stageの pending → active を promotion finding として返す", () => {
    const findings = executionPlanTransitionFindings(
      transition(plan("active", "pending"), plan("active", "active")),
    );

    expect(findings.map((finding) => finding.id)).toEqual(["stage.status.pending-to-active:stage-1"]);
  });
  it("Stageの active → completed を promotion finding として返す", () => {
    const findings = executionPlanTransitionFindings(
      transition(plan("active", "active"), plan("active", "completed")),
    );

    expect(findings.map((finding) => finding.id)).toEqual(["stage.status.active-to-completed:stage-1"]);
  });
  it("Stageの active → blocked は安全側の停止として違反にしない", () => {
    const findings = executionPlanTransitionFindings(
      transition(plan("active", "active"), plan("blocked", "blocked")),
    );

    expect(findings).toEqual([]);
  });
  it("permissions.commit の false → true を promotion finding として返す", () => {
    const base = plan("active", "active");
    const head: ExecutionPlan = {
      ...base,
      permissions: { ...base.permissions, commit: true },
    };

    const findings = executionPlanTransitionFindings(transition(base, head));

    expect(findings.map((finding) => finding.id)).toEqual(["permission.commit.false-to-true"]);
  });
  it("permissions.push と draft_pr の false → true も promotion findingとして返す", () => {
    const base = plan("active", "active");
    const head: ExecutionPlan = {
      ...base,
      permissions: { ...base.permissions, push: true, draft_pr: true },
    };

    const findings = executionPlanTransitionFindings(transition(base, head));

    expect(findings.map((finding) => finding.id)).toEqual([
      "permission.push.false-to-true",
      "permission.draft_pr.false-to-true",
    ]);
  });
  it("permissionのtrue → falseは安全側の縮小として違反にしない", () => {
    const base: ExecutionPlan = {
      ...plan("active", "active"),
      permissions: { commit: true, push: true, draft_pr: true, merge: false },
    };
    const head: ExecutionPlan = {
      ...base,
      permissions: { commit: false, push: false, draft_pr: false, merge: false },
    };

    expect(executionPlanTransitionFindings(transition(base, head))).toEqual([]);
  });
  it("permissions.merge: true はbaseからの拡大でなくても常に拒否する", () => {
    const base = plan("active", "active");
    const head: ExecutionPlan = {
      ...base,
      permissions: { ...base.permissions, merge: true },
    };

    const findings = executionPlanTransitionFindings(transition(base, head));

    expect(findings.map((finding) => finding.id)).toEqual(["permission.merge.always-forbidden"]);
  });
  it("baseとHEADのpermissions.mergeがともにtrueでも常に拒否する", () => {
    const base = plan("active", "active");
    const head: ExecutionPlan = {
      ...base,
      permissions: { ...base.permissions, merge: true },
    };

    expect(executionPlanTransitionFindings(transition(head, head)).map((finding) => finding.id)).toEqual([
      "permission.merge.always-forbidden",
    ]);
  });
  it("新規の proposed plan（全Stage pending・全permission false）は許可する", () => {
    const base = { kind: "absent" };
    const head = { kind: "plan", plan: plan("proposed", "pending") };
    const input = { path: ".ai/local/execution-plans/runtime.md", base, head } as unknown as ExecutionPlanTransition;

    expect(() => executionPlanTransitionFindings(input)).not.toThrow();
    expect(executionPlanTransitionFindings(input)).toEqual([]);
  });
  it("新規Planが proposed 以外のstatusなら promotion finding", () => {
    const base = { kind: "absent" };
    const head = { kind: "plan", plan: plan("active", "active") };
    const input = { path: ".ai/local/execution-plans/runtime.md", base, head } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.new.invalid-state",
    ]);
  });
  it("新規Planに pending 以外のStageがあれば promotion finding", () => {
    const base = { kind: "absent" };
    const head = { kind: "plan", plan: plan("proposed", "active") };
    const input = { path: ".ai/local/execution-plans/runtime.md", base, head } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.new.invalid-state",
    ]);
  });

  it("新規Planのpermissions.merge: trueはgeneric invalid stateと絶対拒否を返す", () => {
    const base = { kind: "absent" };
    const proposed = plan("proposed", "pending");
    const head = {
      kind: "plan",
      plan: { ...proposed, permissions: { ...proposed.permissions, merge: true } },
    };
    const input = { path: ".ai/local/execution-plans/runtime.md", base, head } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.new.invalid-state",
      "permission.merge.always-forbidden",
    ]);
  });

  it("Planの active → completed をterminal promotion findingとして返す", () => {
    const base = plan("active", "active");
    const head = plan("completed", "active");

    const findings = executionPlanTransitionFindings(transition(base, head));

    expect(findings.map((finding) => finding.id)).toEqual(["plan.status.active-to-completed"]);
  });

  it("Planの abandoned / superseded terminal化をpromotion findingとして返す", () => {
    const base = plan("active", "active");
    const abandoned = plan("abandoned", "active");
    const superseded = plan("superseded", "active");

    expect(executionPlanTransitionFindings(transition(base, abandoned)).map((finding) => finding.id)).toEqual([
      "plan.status.active-to-abandoned",
    ]);
    expect(executionPlanTransitionFindings(transition(base, superseded)).map((finding) => finding.id)).toEqual([
      "plan.status.active-to-superseded",
    ]);
  });

  it("status/stage/permission不変のupdated_at・next_action・本文相当の更新は許可する", () => {
    const base = plan("active", "active");
    const head: ExecutionPlan = {
      ...base,
      updated_at: "2026-08-20",
      next_action: { id: "run-stage-1", description: "record evidence" },
      proposals: ["proposal-a"],
    };

    expect(executionPlanTransitionFindings(transition(base, head))).toEqual([]);
  });

  it("1ファイルの複数promotion findingを決定的な順序で返す", () => {
    const base = plan("proposed", "pending");
    const head: ExecutionPlan = {
      ...plan("active", "active"),
      permissions: { commit: true, push: false, draft_pr: false, merge: true },
    };

    const findings = executionPlanTransitionFindings(transition(base, head));

    expect(findings.map((finding) => finding.id)).toEqual([
      "plan.status.proposed-to-active",
      "stage.status.pending-to-active:stage-1",
      "permission.commit.false-to-true",
      "permission.merge.always-forbidden",
    ]);
  });

  it("既存Stageの削除をhistory mutationとして返す", () => {
    const base: ExecutionPlan = {
      ...plan("active", "active"),
      stages: [
        { id: "stage-1", status: "active" },
        { id: "stage-2", status: "pending" },
      ],
    };

    expect(findingIds(base, { ...base, stages: base.stages.slice(0, 1) })).toEqual(["stage.history.deleted"]);
  });

  it("既存StageのID変更をhistory mutationとして返す", () => {
    const base = plan("active", "active");
    expect(findingIds(base, { ...base, stages: [{ id: "renamed-stage", status: "active" }] })).toEqual(["stage.history.id-changed:stage-1"]);
  });

  it("同じ長さのStageの並べ替えをhistory mutationとして返す", () => {
    const base: ExecutionPlan = {
      ...plan("active", "active"),
      stages: [
        { id: "stage-1", status: "active" },
        { id: "stage-2", status: "pending" },
      ],
    };
    const head = { ...base, stages: [base.stages[1]!, base.stages[0]!] };

    expect(findingIds(base, head)).toEqual(["stage.history.id-changed:stage-1", "stage.history.id-changed:stage-2"]);
  });

  it("既存Stageの前へのpending Stage挿入をhistory mutationとして返す", () => {
    const base: ExecutionPlan = {
      ...plan("active", "active"),
      stages: [
        { id: "stage-1", status: "active" },
        { id: "stage-2", status: "pending" },
      ],
    };
    const head: ExecutionPlan = {
      ...base,
      stages: [base.stages[0]!, { id: "stage-new", status: "pending" }, base.stages[1]!],
    };

    expect(findingIds(base, head)).toEqual(["stage.history.id-changed:stage-2", "stage.history.duplicate:stage-2"]);
  });

  it("末尾にpending以外のStageを追加する変更をhistory mutationとして返す", () => {
    const base = plan("active", "active");
    expect(findingIds(base, { ...base, stages: [...base.stages, { id: "stage-2", status: "active" }] })).toEqual([
      "stage.history.append-not-pending:stage-2",
    ]);
  });

  it("既存Stageのproposal_id変更をhistory mutationとして返す", () => {
    const base: ExecutionPlan = {
      ...plan("active", "active"),
      stages: [{ id: "stage-1", status: "active", proposal_id: "proposal-a" }],
    };

    expect(findingIds(base, { ...base, stages: [{ ...base.stages[0]!, proposal_id: "proposal-b" }] })).toEqual([
      "stage.history.proposal-changed:stage-1",
    ]);
  });

  it("末尾へのpending Stage追加は許可する", () => {
    const base = plan("active", "active");
    expect(findingIds(base, { ...base, stages: [...base.stages, { id: "stage-2", status: "pending" }] })).toEqual([]);
  });

  it("末尾に既存IDのStageを重複追加する変更をhistory mutationとして返す", () => {
    const base = plan("active", "active");
    expect(findingIds(base, { ...base, stages: [...base.stages, { id: "stage-1", status: "pending" }] })).toEqual([
      "stage.history.duplicate:stage-1",
    ]);
  });

  it("Planファイルの削除をpromotion findingとして返す", () => {
    const base = plan("proposed", "pending");
    const input = {
      path: ".ai/local/execution-plans/runtime.md",
      base: { kind: "plan", plan: base },
      head: { kind: "absent" },
    } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.file.deleted",
    ]);
  });

  it("merge-base側のPlan frontmatterがunreadableならpromotion finding", () => {
    const input = {
      path: ".ai/local/execution-plans/runtime.md",
      base: { kind: "unreadable", detail: "invalid YAML" },
      head: { kind: "plan", plan: plan("proposed", "pending") },
    } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.frontmatter.unreadable:base",
    ]);
  });

  it("HEAD側のPlan frontmatterがunreadableならpromotion finding", () => {
    const input = {
      path: ".ai/local/execution-plans/runtime.md",
      base: { kind: "plan", plan: plan("proposed", "pending") },
      head: { kind: "unreadable", detail: "invalid YAML" },
    } as unknown as ExecutionPlanTransition;

    expect(executionPlanTransitionFindings(input).map((finding) => finding.id)).toEqual([
      "plan.frontmatter.unreadable:head",
    ]);
  });

  it("nullのPlan本文をabsent stateへ分類する", () => {
    expect(executionPlanPromotion.executionPlanFileStateFromText(null)).toEqual({ kind: "absent" });
  });

  it("invalidなPlan frontmatterをunreadable stateへ分類する", () => {
    const state = executionPlanPromotion.executionPlanFileStateFromText("---\nstatus: active\n---\n");

    expect(state).toMatchObject({ kind: "unreadable" });
  });

  it("validなMarkdown frontmatterをPlan stateへ分類する", () => {
    const text = `---
schema_version: 1
id: runtime
status: proposed
updated_at: 2026-08-19
proposals: []
permissions:
  commit: false
  push: false
  draft_pr: false
  merge: false
stages:
  - id: stage-1
    status: pending
---

# Runtime plan
`;

    expect(typeof executionPlanPromotion.executionPlanFileStateFromText).toBe("function");
    const state = (executionPlanPromotion.executionPlanFileStateFromText as (value: string) => unknown)(text);

    expect(state).toMatchObject({ kind: "plan", plan: { id: "runtime", status: "proposed" } });
  });
});
