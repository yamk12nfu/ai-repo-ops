/**
 * `aro init` コマンド。対象 repo に AI 運用基盤ファイルを初回展開する（計画 v3 §17.1）。
 *
 * 処理: repo/git 確認 → source/distribution 読込 → lock 不在確認 → plan 生成（lock=null）→
 * conflict（=既存ファイルが managed_overwrite 対象に存在）なら blocked → apply（managed/seed 作成・patch 追記・lock 生成）。
 *
 * 全変更は {@link import("../core/planner.js").buildSyncPlan} → {@link import("../core/apply.js").applyPlan}
 * を経由する（§5.2）。conflict 時は一切書き込まない（§5.3）。
 *
 * 終了コード:
 *   0: 成功
 *   1: validation error（git repo でない / manifest 不正 / path 不正 / source 不在 など）
 *   2: blocked（lock が既にある / 既存ファイルが managed 対象と衝突）
 *   3: unexpected error（書き込み中の I/O 失敗など）
 */
import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import { ApplyIoError, applyPlan } from "../core/apply.js";
import { AroError } from "../core/errors.js";
import { assertGitRepo } from "../core/git.js";
import { loadLockFile } from "../core/lockfile.js";
import { buildSyncPlan } from "../core/planner.js";
import { loadDistribution, resolveSourceRoot } from "../core/source.js";
import { deriveRepoName } from "../core/template.js";
import type { SyncPlan } from "../types/plan.js";
import { formatInitApplied, type InitMeta } from "./apply-format.js";
import { errorToJson, formatApplyIoError, formatAroError } from "./cli-error.js";
import { formatDiffHuman } from "./diff-format.js";
import { defaultSourceStartDir } from "./source-context.js";

/** init の終了コード。 */
export const INIT_EXIT = {
  /** 成功。 */
  ok: 0,
  /** validation error（AroError 由来）。 */
  validation: 1,
  /** blocked（lock 既存 / 既存ファイル衝突）。 */
  blocked: 2,
  /** unexpected error（I/O 失敗・非 AroError）。 */
  unexpected: 3,
} as const;

/** init コマンドのオプション（共通オプションのみ）。 */
export type InitOptions = CommonOptions;

/** executeInit が使う I/O（テストでは writer / clock を差し替える）。 */
export interface InitIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** lock の created_at/updated_at に使う ISO 文字列を返す（決定性のため注入する）。 */
  now: () => string;
}

/** conflict（既存ファイルが managed 対象と衝突）を人間向けに整形する。 */
function formatBlockedConflicts(plan: SyncPlan): string {
  const conflicts = plan.changes.filter((c) => c.kind === "conflict");
  const lines: string[] = [];
  lines.push("ERROR repo に既存ファイルがあり managed_overwrite 対象を上書きできません。");
  lines.push("      init は既存ファイルを上書きしません。下記を退避するか、既に初期化済みなら `aro sync` を使ってください。");
  lines.push("");
  lines.push("Conflicting files:");
  for (const c of conflicts) {
    lines.push(`  ! ${c.path}`);
    if (c.reason !== undefined) {
      lines.push(`    reason: ${c.reason}`);
    }
  }
  return lines.join("\n");
}

/**
 * init を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link InitIo} 経由で行うため、テストから writer / clock を差し替えて検証できる。
 */
export async function executeInit(options: InitOptions, io: InitIo): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
    const distribution = await loadDistribution(sourceRoot, options.distribution);

    const existingLock = await loadLockFile(repoRoot);
    if (existingLock !== null) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "init", ok: false, reason: "already_initialized" }, null, 2)}\n`);
      } else {
        io.stderr(
          "ERROR repo はすでに初期化済みです（.ai/ai-repo-ops.lock.yaml が存在します）。\n" +
            "      更新は `aro diff` / `aro sync` を使ってください（`aro init` ではありません）。\n",
        );
      }
      return INIT_EXIT.blocked;
    }

    const plan = await buildSyncPlan({ repoRoot, distribution, lock: null });

    if (plan.hasConflicts) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "init", ok: false, reason: "conflict", plan }, null, 2)}\n`);
      } else {
        io.stderr(`${formatBlockedConflicts(plan)}\n`);
      }
      return INIT_EXIT.blocked;
    }

    if (options.dryRun) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "init", ok: true, dryRun: true, plan }, null, 2)}\n`);
      } else {
        io.stdout(`${formatDiffHuman(plan, { color: io.color })}\n\n(dry-run: ファイルは書き込まれていません)\n`);
      }
      return INIT_EXIT.ok;
    }

    const result = await applyPlan({
      plan,
      distribution,
      repoRoot,
      existingLock: null,
      now: io.now(),
      repoName: deriveRepoName(repoRoot),
    });

    if (options.json) {
      io.stdout(`${JSON.stringify({ command: "init", ok: true, applied: result }, null, 2)}\n`);
    } else {
      const meta: InitMeta = {
        repoRoot,
        distribution: plan.distribution,
        version: plan.targetVersion,
        targetContentSha256: plan.targetDistributionSha256,
      };
      io.stdout(`${formatInitApplied(result, meta, io.color)}\n`);
    }
    return INIT_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "init", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else if (error instanceof ApplyIoError) {
      io.stderr(`${formatApplyIoError(error)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    if (error instanceof ApplyIoError) {
      return INIT_EXIT.unexpected;
    }
    return error instanceof AroError ? INIT_EXIT.validation : INIT_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro init` を登録する。 */
export function registerInit(program: Command): void {
  const command = program
    .command("init")
    .summary("対象repoにAI運用基盤ファイルを初回展開する")
    .description(
      "対象repoに .ai/ と .github/workflows/ などのAI運用基盤ファイルを初回展開し、lock fileを生成する。",
    );

  addCommonOptions(command).action(async (options: InitOptions) => {
    const code = await executeInit(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
      now: () => new Date().toISOString(),
    });
    process.exitCode = code;
  });
}
