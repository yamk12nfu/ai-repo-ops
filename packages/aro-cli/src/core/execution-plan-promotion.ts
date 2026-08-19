import {
  executionPlanSchema,
  type ExecutionPlan,
} from "./execution-plans.js";
import { splitProposalFrontmatter } from "./proposal-frontmatter.js";
import { parseYaml } from "./yaml.js";
import picomatch from "picomatch";

export const EXECUTION_PLAN_PROMOTION_GLOB = ".ai/local/execution-plans/*.md";
const executionPlanPromotionMatcher = picomatch(EXECUTION_PLAN_PROMOTION_GLOB, { dot: true, nocase: true });

export function isExecutionPlanPromotionTarget(path: string): boolean {
  return executionPlanPromotionMatcher(path);
}

export type ExecutionPlanFileState =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "plan"; plan: ExecutionPlan };

export interface ExecutionPlanTransition {
  path: string;
  base: ExecutionPlanFileState;
  head: ExecutionPlanFileState;
}

export interface ExecutionPlanPromotionFinding {
  id: string;
  path: string;
  message: string;
}

export function executionPlanFileStateFromText(text: string | null): ExecutionPlanFileState {
  if (text === null) return { kind: "absent" };

  try {
    const { frontmatterYaml } = splitProposalFrontmatter(text);
    const parsed = executionPlanSchema.safeParse(parseYaml(frontmatterYaml));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { kind: "unreadable", detail };
    }
    return { kind: "plan", plan: parsed.data };
  } catch (error) {
    return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function executionPlanTransitionFindings(
  transition: ExecutionPlanTransition,
): ExecutionPlanPromotionFinding[] {
  const { path, base, head } = transition;
  const findings: ExecutionPlanPromotionFinding[] = [];
  if (base.kind === "unreadable") {
    findings.push({
      id: "plan.frontmatter.unreadable:base",
      path,
      message: `merge-base側のExecution Plan frontmatterを読めず、遷移を判定できません（${base.detail}）: ${path}`,
    });
  }
  if (head.kind === "unreadable") {
    findings.push({
      id: "plan.frontmatter.unreadable:head",
      path,
      message: `HEAD側のExecution Plan frontmatterを読めず、遷移を判定できません（${head.detail}）: ${path}`,
    });
  }
  if (findings.length > 0) return findings;
  if (base.kind === "absent") {
    if (
      head.kind === "plan" &&
      (head.plan.status !== "proposed" ||
        head.plan.stages.some((stage) => stage.status !== "pending") ||
        Object.values(head.plan.permissions).some((allowed) => allowed))
    ) {
      findings.push({
        id: "plan.new.invalid-state",
        path,
        message: `新規Execution Planはstatus: proposed、全Stage pending、全permission falseで追加する必要があります: ${path}`,
      });
    }
    if (head.kind === "plan" && head.plan.permissions.merge) {
      findings.push({
        id: "permission.merge.always-forbidden",
        path,
        message: `permissions.merge: true は常に許可されません。人間のreviewが必要です: ${path}`,
      });
    }
    return findings;
  }
  if (head.kind === "absent") {
    findings.push({
      id: "plan.file.deleted",
      path,
      message: `Execution Planファイルを削除しています。人間のreviewが必要です: ${path}`,
    });
    return findings;
  }
  if (base.kind !== "plan" || head.kind !== "plan") return findings;
  const safePlanStop = base.plan.status === "active" && head.plan.status === "blocked";
  if (base.plan.status !== head.plan.status && !safePlanStop) {
    findings.push({
      id: `plan.status.${base.plan.status}-to-${head.plan.status}`,
      path,
      message: `Execution Planのstatusを${base.plan.status}から${head.plan.status}へ変更しています。人間のreviewが必要です: ${path}`,
    });
  }
  if (head.plan.stages.length < base.plan.stages.length) {
    findings.push({
      id: "stage.history.deleted",
      path,
      message: `既存Stageの履歴を削除しています。人間のreviewが必要です: ${path}`,
    });
  }
  const existingStageCount = Math.min(base.plan.stages.length, head.plan.stages.length);
  for (let index = 0; index < existingStageCount; index += 1) {
    const baseStage = base.plan.stages[index]!;
    const headStage = head.plan.stages[index]!;
    if (baseStage.id !== headStage.id) {
      findings.push({
        id: `stage.history.id-changed:${baseStage.id}`,
        path,
        message: `既存StageのIDを${baseStage.id}から${headStage.id}へ変更または並べ替えています。人間のreviewが必要です: ${path}`,
      });
    }
    if (baseStage.proposal_id !== headStage.proposal_id) {
      findings.push({
        id: `stage.history.proposal-changed:${baseStage.id}`,
        path,
        message: `既存Stage ${baseStage.id} のproposal_idを変更しています。人間のreviewが必要です: ${path}`,
      });
    }
  }
  const seenStageIds = new Set(base.plan.stages.map((stage) => stage.id));
  for (let index = base.plan.stages.length; index < head.plan.stages.length; index += 1) {
    const headStage = head.plan.stages[index]!;
    if (seenStageIds.has(headStage.id)) {
      findings.push({
        id: `stage.history.duplicate:${headStage.id}`,
        path,
        message: `Stage ID ${headStage.id} を重複して追加しています。人間のreviewが必要です: ${path}`,
      });
    }
    seenStageIds.add(headStage.id);
    if (headStage.status !== "pending") {
      findings.push({
        id: `stage.history.append-not-pending:${headStage.id}`,
        path,
        message: `新規Stage ${headStage.id} は末尾にpendingでのみ追加できます。人間のreviewが必要です: ${path}`,
      });
    }
  }
  for (const baseStage of base.plan.stages) {
    const headStage = head.plan.stages.find((stage) => stage.id === baseStage.id);
    const safeStop = baseStage.status === "active" && headStage?.status === "blocked";
    if (headStage !== undefined && baseStage.status !== headStage.status && !safeStop) {
      findings.push({
        id: `stage.status.${baseStage.status}-to-${headStage.status}:${baseStage.id}`,
        path,
        message: `Stage ${baseStage.id} を${baseStage.status}から${headStage.status}へ変更しています。人間のreviewが必要です: ${path}`,
      });
    }
  }
  for (const permission of ["commit", "push", "draft_pr"] as const) {
    if (!base.plan.permissions[permission] && head.plan.permissions[permission]) {
      findings.push({
        id: `permission.${permission}.false-to-true`,
        path,
        message: `permissions.${permission} をfalseからtrueへ拡大しています。人間のreviewが必要です: ${path}`,
      });
    }
  }
  if (head.plan.permissions.merge) {
    findings.push({
      id: "permission.merge.always-forbidden",
      path,
      message: `permissions.merge: true は常に許可されません。人間のreviewが必要です: ${path}`,
    });
  }
  return findings;
}
