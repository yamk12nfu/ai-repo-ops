/**
 * `aro sync` コマンド。中央配布物を対象 repo へ適用する（計画 v3 §17.3）。
 *
 * 処理: repo/git 確認 → source/distribution 読込 → lock 読込（無くてもよい）→ plan 生成 →
 * conflict があれば一切書き込まず abort（§5.3）→ 適用対象が無ければ up to date →
 * apply（create/update/append・lock 更新）。
 *
 * atomicity:
 *   - conflict が 1 件でもあれば apply せず abort。対象 repo には一切書き込まない。
 *   - apply は全変更をメモリ上で準備してから書く。書き込み中の I/O 失敗は touched paths を表示する（§17.3）。
 *
 * 終了コード:
 *   0: 成功（適用済み / up to date / dry-run で conflict なし）
 *   1: validation error（manifest 不正 / path 不正 / source 不在 / lock 破損 など）
 *   2: conflict（abort。ファイルは変更しない / dry-run で conflict 検出）
 *   3: unexpected error（書き込み中の I/O 失敗など）
 */
import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import { ApplyIoError, applyPlan } from "../core/apply.js";
import { AroError } from "../core/errors.js";
import { assertGitRepo } from "../core/git.js";
import { loadLockFile } from "../core/lockfile.js";
import { buildSyncPlan } from "../core/planner.js";
import { planRequiresSync } from "../core/plan-summary.js";
import { loadDistribution, resolveSourceRoot } from "../core/source.js";
import { deriveRepoName } from "../core/template.js";
import type { SyncPlan } from "../types/plan.js";
import { formatSyncApplied, formatSyncUpToDate, type SyncMeta } from "./apply-format.js";
import { errorToJson, formatApplyIoError, formatAroError } from "./cli-error.js";
import { formatDiffHuman } from "./diff-format.js";
import { defaultSourceStartDir } from "./source-context.js";

/** sync の終了コード。 */
export const SYNC_EXIT = {
  /** 成功（適用 / up to date / dry-run conflict なし）。 */
  ok: 0,
  /** validation error（AroError 由来）。 */
  validation: 1,
  /** conflict（abort）/ dry-run で conflict 検出。 */
  conflict: 2,
  /** unexpected error（I/O 失敗・非 AroError）。 */
  unexpected: 3,
} as const;

/** conflict abort 時のメッセージ（§5.3）。 */
const ABORT_MESSAGE = "Sync aborted because conflicts were detected.\nNo files were modified.";

/** sync コマンドのオプション（共通オプションのみ）。 */
export type SyncOptions = CommonOptions;

/** executeSync が使う I/O（テストでは writer / clock を差し替える）。 */
export interface SyncIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** lock の created_at/updated_at に使う ISO 文字列を返す（決定性のため注入する）。 */
  now: () => string;
}

/** plan から sync 出力用メタ情報を作る。 */
function syncMeta(plan: SyncPlan): SyncMeta {
  return {
    repoRoot: plan.repoRoot,
    distribution: plan.distribution,
    currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion,
    currentContentSha256: plan.currentDistributionSha256,
    targetContentSha256: plan.targetDistributionSha256,
  };
}

/**
 * sync を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link SyncIo} 経由で行うため、テストから writer / clock を差し替えて検証できる。
 */
export async function executeSync(options: SyncOptions, io: SyncIo): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
    const distribution = await loadDistribution(sourceRoot, options.distribution);
    const existingLock = await loadLockFile(repoRoot);

    const plan = await buildSyncPlan({ repoRoot, distribution, lock: existingLock });

    // dry-run は純粋なプレビュー。書き込みはせず、conflict の有無を終了コードへ反映する。
    if (options.dryRun) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "sync", dryRun: true, plan }, null, 2)}\n`);
      } else {
        io.stdout(`${formatDiffHuman(plan, { color: io.color })}\n\n(dry-run: ファイルは書き込まれていません)\n`);
      }
      return plan.hasConflicts ? SYNC_EXIT.conflict : SYNC_EXIT.ok;
    }

    if (plan.hasConflicts) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "sync", ok: false, reason: "conflict", plan }, null, 2)}\n`);
      } else {
        io.stdout(`${formatDiffHuman(plan, { color: io.color })}\n`);
        io.stderr(`${ABORT_MESSAGE}\n`);
      }
      return SYNC_EXIT.conflict;
    }

    if (!planRequiresSync(plan)) {
      if (options.json) {
        io.stdout(`${JSON.stringify({ command: "sync", ok: true, upToDate: true, plan }, null, 2)}\n`);
      } else {
        io.stdout(`${formatSyncUpToDate(syncMeta(plan), io.color)}\n`);
      }
      return SYNC_EXIT.ok;
    }

    const result = await applyPlan({
      plan,
      distribution,
      repoRoot,
      existingLock,
      now: io.now(),
      repoName: deriveRepoName(repoRoot),
    });

    if (options.json) {
      io.stdout(`${JSON.stringify({ command: "sync", ok: true, applied: result }, null, 2)}\n`);
    } else {
      io.stdout(`${formatSyncApplied(result, syncMeta(plan), io.color)}\n`);
    }
    return SYNC_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "sync", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else if (error instanceof ApplyIoError) {
      io.stderr(`${formatApplyIoError(error)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    if (error instanceof ApplyIoError) {
      return SYNC_EXIT.unexpected;
    }
    return error instanceof AroError ? SYNC_EXIT.validation : SYNC_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro sync` を登録する。 */
export function registerSync(program: Command): void {
  const command = program
    .command("sync")
    .summary("中央配布物を対象repoへ同期する")
    .description(
      "中央配布物を対象repoへ適用する。conflictが1つでもあれば一切変更せずabortする。",
    );

  addCommonOptions(command).action(async (options: SyncOptions) => {
    const code = await executeSync(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
      now: () => new Date().toISOString(),
    });
    process.exitCode = code;
  });
}
