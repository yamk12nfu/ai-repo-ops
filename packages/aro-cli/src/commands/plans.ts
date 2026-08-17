import type { Command } from "commander";

import { assertGitRepo } from "../core/git.js";
import { runExecutionPlanCheck, runExecutionPlanNext, type ExecutionPlanReport } from "../core/execution-plans.js";
import { errorToJson, formatAroError } from "./cli-error.js";

export const PLANS_EXIT = { ok: 0, failures: 1, unexpected: 3 } as const;

export interface PlansCheckOptions {
  repo: string;
  strict: boolean;
  json: boolean;
}

export interface PlansStatusOptions { repo: string; json: boolean }
export interface PlansNextOptions { repo: string; json: boolean }

export interface PlansIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function formatCheck(report: ExecutionPlanReport): string {
  const lines = ["ai-repo-ops plans check", "", `Repo:   ${report.repoRoot}`, ""];
  lines.push(...report.findings.map((finding) => `FAIL  ${finding.id}: ${finding.message}${finding.path === undefined ? "" : ` [path=${finding.path}]`}${finding.planId === undefined ? "" : ` [plan=${finding.planId}]`}`));
  lines.push("", "Summary:", `  ${report.summary.plans} plans`, `  ${report.summary.failed} failed`);
  return lines.join("\n");
}

export async function executePlansCheck(options: PlansCheckOptions, io: PlansIo): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const report = await runExecutionPlanCheck(repoRoot);
    if (options.strict) {
      const next = await runExecutionPlanNext(repoRoot);
      report.findings.push(...next.blockers.filter((blocker) => blocker.code.startsWith("proposal-")).map((blocker) => ({
        id: `next.${blocker.code}`,
        message: blocker.message,
      })));
      report.summary.failed = report.findings.length;
      report.hasFailures = report.findings.length > 0;
    }
    if (options.json) {
      io.stdout(`${JSON.stringify({ command: "plans check", ok: !report.hasFailures, report }, null, 2)}\n`);
    } else {
      io.stdout(`${formatCheck(report)}\n`);
    }
    return report.hasFailures ? PLANS_EXIT.failures : PLANS_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "plans check", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return PLANS_EXIT.unexpected;
  }
}

export async function executePlansStatus(options: PlansStatusOptions, io: PlansIo): Promise<number> {
  try {
    const report = await runExecutionPlanCheck(await assertGitRepo(options.repo));
    const active = report.records.filter((record) => record.plan.status === "active");
    const selected = active.length === 1 ? active[0]?.plan ?? null : null;
    const body = {
      command: "plans status",
      ok: !report.hasFailures && active.length <= 1,
      repoRoot: report.repoRoot,
      active_plan: selected === null || selected === undefined ? null : {
        id: selected.id,
        status: selected.status,
        current_stage: selected.current_stage ?? null,
        stage: selected.stages.find((stage) => stage.id === selected.current_stage) ?? null,
      },
      plans: report.plans,
    };
    if (options.json) io.stdout(JSON.stringify(body, null, 2) + "\n");
    else io.stdout(`ai-repo-ops plans status\n\n${selected === null ? "No active execution plan." : selected.id + " " + (selected.current_stage ?? "")}\n`);
    return body.ok ? PLANS_EXIT.ok : PLANS_EXIT.failures;
  } catch (error) {
    io.stderr(options.json ? JSON.stringify({ command: "plans status", ok: false, error: errorToJson(error) }, null, 2) + "\n" : formatAroError(error) + "\n");
    return PLANS_EXIT.unexpected;
  }
}

export async function executePlansNext(options: PlansNextOptions, io: PlansIo): Promise<number> {
  try {
    const result = await runExecutionPlanNext(await assertGitRepo(options.repo));
    const body = { command: "plans next", ok: true, ...result };
    if (options.json) io.stdout(JSON.stringify(body, null, 2) + "\n");
    else io.stdout(`ai-repo-ops plans next\n\nRunnable: ${result.runnable ? "yes" : "no"}\n`);
    return PLANS_EXIT.ok;
  } catch (error) {
    io.stderr(options.json ? JSON.stringify({ command: "plans next", ok: false, error: errorToJson(error) }, null, 2) + "\n" : formatAroError(error) + "\n");
    return PLANS_EXIT.unexpected;
  }
}

/** repo固有 execution plan の検証・状態確認コマンド群を登録する。 */
export function registerPlans(program: Command): void {
  const plans = program
    .command("plans")
    .summary("execution planを検証・確認する")
    .description(".ai/local/execution-plans 配下のexecution planを読み取り専用で扱う。");

  plans
    .command("check")
    .summary("execution planのschemaとinvariantを検証する")
      .option("--repo <path>", "対象repoのpath。", ".")
      .option("--json", "JSONで結果を出力する。", false)
      .option("--strict", "構造・invariant違反に加え、current actionのProposal readiness/freshnessも検証する。", false)
      .action(async (options: PlansCheckOptions) => {
        const code = await executePlansCheck(options, {
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
        });
        process.exitCode = code;
      });

  plans
    .command("status")
    .summary("active execution planの現在地を表示する")
    .option("--repo <path>", "対象repoのpath。", ".")
    .option("--json", "JSONで結果を出力する。", false)
    .action(async (options: PlansStatusOptions) => {
      process.exitCode = await executePlansStatus(options, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    });
  plans
    .command("next")
    .summary("現在のnext actionと実行可否を表示する")
    .option("--repo <path>", "対象repoのpath。", ".")
    .option("--json", "JSONで結果を出力する。", false)
    .action(async (options: PlansNextOptions) => {
      process.exitCode = await executePlansNext(options, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    });
}
