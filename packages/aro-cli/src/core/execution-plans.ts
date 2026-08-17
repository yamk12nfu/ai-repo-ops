import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { forbiddenSourcePattern, readUtf8TextWithinRoot } from "./knowledge-check.js";
import { inspectKnowledgeSourceGit, isRegularKnowledgeSourceEntry } from "./knowledge-git.js";
import { parseYaml } from "./yaml.js";
import { PROPOSALS_ROOT, parseProposalDocument, splitProposalFrontmatter, type ProposalFrontmatter } from "./proposal-frontmatter.js";

export const EXECUTION_PLANS_ROOT = ".ai/local/execution-plans";
export const EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const nextActionSchema = z
  .object({
    id: z.string().regex(ID),
    proposal_id: z.string().regex(ID).optional(),
    description: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .strict();

const permissionSchema = z
  .object({
    commit: z.boolean(),
    push: z.boolean(),
    draft_pr: z.boolean(),
    merge: z.boolean(),
  })
  .strict();

const stageSchema = z
  .object({
    id: z.string().regex(ID),
    status: z.enum(["pending", "active", "blocked", "completed"]),
    proposal_id: z.string().regex(ID).optional(),
  })
  .strict();

export const executionPlanSchema = z
  .object({
    schema_version: z.literal(EXECUTION_PLAN_SCHEMA_VERSION),
    id: z.string().regex(ID),
    status: z.enum(["proposed", "active", "blocked", "completed", "abandoned", "superseded"]),
    current_stage: z.string().regex(ID).optional(),
    next_action: nextActionSchema.optional(),
    updated_at: z.string().min(1),
    proposals: z.array(z.string().regex(ID)),
    permissions: permissionSchema,
    stages: z.array(stageSchema).min(1),
  })
  .strict();

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type ExecutionPlanStage = ExecutionPlan["stages"][number];
export type ExecutionPlanNextAction = NonNullable<ExecutionPlan["next_action"]>;

export interface ExecutionPlanRecord {
  fileName: string;
  relativePath: string;
  plan: ExecutionPlan;
}

export interface ExecutionPlanFinding {
  id: string;
  path?: string;
  planId?: string;
  message: string;
}

export interface ExecutionPlanReport {
  repoRoot: string;
  plans: string[];
  records: ExecutionPlanRecord[];
  findings: ExecutionPlanFinding[];
  summary: { plans: number; failed: number };
  hasFailures: boolean;
}

export interface ExecutionPlanBlocker { code: string; message: string; proposal_id?: string }
export interface ExecutionPlanNextResult {
  repoRoot: string;
  plan: { id: string; status: ExecutionPlan["status"] } | null;
  stage: ExecutionPlanStage | null;
  next_action: ExecutionPlanNextAction | null;
  permissions: ExecutionPlan["permissions"] | null;
  runnable: boolean;
  blockers: ExecutionPlanBlocker[];
}

async function findProposal(repoRoot: string, id: string): Promise<ProposalFrontmatter | null | undefined | "ambiguous"> {
  const root = path.join(repoRoot, PROPOSALS_ROOT);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? null : undefined;
  }
  let invalid = false;
  let match: ProposalFrontmatter | undefined;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md") || !entry.isFile()) continue;
    const read = await readUtf8TextWithinRoot(repoRoot, PROPOSALS_ROOT + "/" + entry.name, "proposal");
    if (read.kind !== "ok") { invalid = true; continue; }
    try {
      const document = parseProposalDocument(read.text, PROPOSALS_ROOT + "/" + entry.name);
      if (document.frontmatter.id === id) {
        if (match !== undefined) return "ambiguous";
        match = document.frontmatter;
      }
    } catch {
      invalid = true;
    }
  }
  return invalid ? undefined : match ?? null;
}

async function proposalFreshness(repoRoot: string, proposal: ProposalFrontmatter): Promise<"fresh" | "stale" | "undeterminable"> {
  for (const source of proposal.sources) {
    if (forbiddenSourcePattern(source.path) !== undefined) return "undeterminable";
    let state;
    try {
      state = await inspectKnowledgeSourceGit(repoRoot, source.path, proposal.proposed_at_commit);
    } catch {
      return "undeterminable";
    }
    if (state.commitState !== "ancestor" || state.stale === null || state.headEntry === null || state.verifiedEntry === null ||
        !isRegularKnowledgeSourceEntry(state.headEntry) || !isRegularKnowledgeSourceEntry(state.verifiedEntry)) return "undeterminable";
    if (state.stale) return "stale";
  }
  return "fresh";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function finding(id: string, message: string, context: Partial<ExecutionPlanFinding> = {}): ExecutionPlanFinding {
  return { id, message, ...context };
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)") + ": " + issue.message)
    .join("; ");
}

async function listPlanFiles(repoRoot: string, findings: ExecutionPlanFinding[]): Promise<string[]> {
  const root = path.join(repoRoot, EXECUTION_PLANS_ROOT);
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory()) {
      findings.push(finding("plans.root", EXECUTION_PLANS_ROOT + " is not a directory", { path: EXECUTION_PLANS_ROOT }));
      return [];
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (entry.isDirectory()) {
      findings.push(finding("document.file", "execution plan is not a file: " + entry.name, {
        path: EXECUTION_PLANS_ROOT + "/" + entry.name,
      }));
      continue;
    }
    files.push(entry.name);
  }
  return files;
}

async function parsePlanFile(
  repoRoot: string,
  fileName: string,
  findings: ExecutionPlanFinding[],
): Promise<ExecutionPlanRecord | null> {
  const relativePath = EXECUTION_PLANS_ROOT + "/" + fileName;
  const read = await readUtf8TextWithinRoot(repoRoot, relativePath, "execution plan");
  if (read.kind !== "ok") {
    findings.push(finding("document." + read.kind, "execution planを読めません: " + fileName, { path: relativePath }));
    return null;
  }
  try {
    const split = splitProposalFrontmatter(read.text, relativePath);
    const value = parseYaml(split.frontmatterYaml);
    const result = executionPlanSchema.safeParse(value);
    if (!result.success) {
      findings.push(finding("frontmatter.schema", zodMessage(result.error), { path: relativePath }));
      return null;
    }
    return { fileName, relativePath, plan: result.data };
  } catch (error) {
    findings.push(finding("frontmatter.parse", error instanceof Error ? error.message : String(error), {
      path: relativePath,
    }));
    return null;
  }
}

function validatePlan(record: ExecutionPlanRecord, findings: ExecutionPlanFinding[]): void {
  const plan = record.plan;
  const stages = plan.stages;
  const stageRank = { completed: 0, active: 1, blocked: 1, pending: 2 } as const;
  for (let index = 1; index < stages.length; index += 1) {
    if (stageRank[stages[index]!.status] < stageRank[stages[index - 1]!.status]) {
      findings.push(finding("stage.order", "stage列をcompleted/active/blockedからpendingへ逆行させることはできません", { path: record.relativePath, planId: plan.id }));
      break;
    }
  }
  if (plan.permissions.merge) findings.push(finding("permissions.merge", "permissions.merge: true はv1では許可されません", { path: record.relativePath, planId: plan.id }));
  const active = stages.filter((stage) => stage.status === "active");
  const blocked = stages.filter((stage) => stage.status === "blocked");
  const seenStageIds = new Set<string>();
  for (const stage of stages) {
    if (seenStageIds.has(stage.id)) findings.push(finding("stage.id-duplicate", `stage IDが重複しています: ${stage.id}`, { path: record.relativePath, planId: plan.id }));
    seenStageIds.add(stage.id);
  }
  if (plan.status === "active") {
    if (active.length !== 1) findings.push(finding("stage.active-count", "active planはactive stageをちょうど1件持つ必要があります", { path: record.relativePath, planId: plan.id }));
    if (plan.current_stage !== active[0]?.id) findings.push(finding("stage.current-mismatch", "current_stageはactive stageのIDと一致する必要があります", { path: record.relativePath, planId: plan.id }));
    if (plan.next_action === undefined) findings.push(finding("next_action.required", "active planにはnext_actionが必要です", { path: record.relativePath, planId: plan.id }));
  }
  if (plan.status === "blocked") {
    if (blocked.length !== 1) findings.push(finding("stage.blocked-count", "blocked planはblocked stageをちょうど1件持つ必要があります", { path: record.relativePath, planId: plan.id }));
    if (plan.current_stage !== blocked[0]?.id) findings.push(finding("stage.blocked-mismatch", "current_stageはblocked stageのIDと一致する必要があります", { path: record.relativePath, planId: plan.id }));
  }
  if (["completed", "abandoned", "superseded"].includes(plan.status)) {
    if (plan.current_stage !== undefined) findings.push(finding("terminal.current-stage", "terminal planはcurrent_stageを持てません", { path: record.relativePath, planId: plan.id }));
    if (plan.next_action !== undefined) findings.push(finding("terminal.next-action", "terminal planはnext_actionを持てません", { path: record.relativePath, planId: plan.id }));
    if (active.length > 0 || blocked.length > 0) findings.push(finding("terminal.stage", "terminal planはactive/blocked stageを持てません", { path: record.relativePath, planId: plan.id }));
  }
}

/** Execution Plan frontmatterを決定的に読み取り、構造を検証する。 */
export async function runExecutionPlanCheck(repoRoot: string): Promise<ExecutionPlanReport> {
  const resolvedRoot = path.resolve(repoRoot);
  const findings: ExecutionPlanFinding[] = [];
  const fileNames = await listPlanFiles(resolvedRoot, findings);
  const records: ExecutionPlanRecord[] = [];
  for (const fileName of fileNames) {
    const record = await parsePlanFile(resolvedRoot, fileName, findings);
    if (record !== null) {
      records.push(record);
      validatePlan(record, findings);
    }
  }
  const activePlans = records.filter((record) => record.plan.status === "active");
  if (activePlans.length > 1) findings.push(finding("plan.active-multiple", "active planはrepoごとに最大1件です", { planId: activePlans.map((record) => record.plan.id).join(",") }));
  const seenPlanIds = new Set<string>();
  for (const record of records) {
    if (seenPlanIds.has(record.plan.id)) findings.push(finding("plan.id-duplicate", `execution plan IDが重複しています: ${record.plan.id}`, { path: record.relativePath, planId: record.plan.id }));
    seenPlanIds.add(record.plan.id);
  }
  const plans = records.map((record) => record.plan.id);
  return {
    repoRoot: resolvedRoot,
    plans,
    records,
    findings,
    summary: { plans: fileNames.length, failed: findings.length },
    hasFailures: findings.length > 0,
  };
}

export async function runExecutionPlanNext(repoRoot: string): Promise<ExecutionPlanNextResult> {
  const report = await runExecutionPlanCheck(repoRoot);
  const active = report.records.filter((record) => record.plan.status === "active");
  const blocked = report.records.filter((record) => record.plan.status === "blocked");
  const record = active.length === 1 ? active[0] : active.length === 0 && blocked.length === 1 ? blocked[0] : undefined;
  const plan = record?.plan;
  const blockers: ExecutionPlanBlocker[] = active.length > 1
      ? [{ code: "multiple-active-plans", message: "active planが複数あり自動選択できません" }]
      : report.hasFailures
        ? [{ code: "plan-invalid", message: "execution planにschema/invariant違反があります" }]
      : active.length === 0 && blocked.length === 1
        ? [{ code: "plan-blocked", message: "planがblocked状態です" }]
      : active.length === 0
      ? [{ code: "no-active-plan", message: "active planがありません" }]
      : [];
  if (plan !== undefined && blockers.length === 0 && plan.next_action?.proposal_id !== undefined) {
    const proposal = await findProposal(report.repoRoot, plan.next_action.proposal_id);
    if (proposal === "ambiguous") blockers.push({ code: "proposal-freshness-undeterminable", message: "参照Proposal IDに一致するProposalが複数ありfreshnessを判定できません", proposal_id: plan.next_action.proposal_id });
    if (proposal === null) blockers.push({ code: "proposal-missing", message: "参照Proposalが存在しません", proposal_id: plan.next_action.proposal_id });
    if (proposal === undefined) blockers.push({ code: "proposal-freshness-undeterminable", message: "参照Proposalを読み取れずfreshnessを判定できません", proposal_id: plan.next_action.proposal_id });
    if (proposal !== "ambiguous" && proposal !== null && proposal !== undefined && proposal.status !== "accepted") blockers.push({ code: "proposal-not-accepted", message: "参照Proposalがacceptedではありません", proposal_id: plan.next_action.proposal_id });
    if (proposal !== "ambiguous" && proposal?.status === "accepted") {
      const freshness = await proposalFreshness(report.repoRoot, proposal);
      if (freshness === "stale") blockers.push({ code: "proposal-stale", message: "参照Proposalのsourceがstaleです", proposal_id: plan.next_action.proposal_id });
      if (freshness === "undeterminable") blockers.push({ code: "proposal-freshness-undeterminable", message: "参照Proposalのfreshnessを判定できません", proposal_id: plan.next_action.proposal_id });
    }
  }
  return {
    repoRoot: report.repoRoot,
    plan: plan === undefined ? null : { id: plan.id, status: plan.status },
    stage: plan === undefined ? null : plan.stages.find((stage) => stage.id === plan.current_stage) ?? null,
    next_action: plan?.next_action ?? null,
    permissions: plan?.permissions ?? null,
    runnable: plan !== undefined && blockers.length === 0,
    blockers,
  };
}
