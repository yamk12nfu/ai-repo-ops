/**
 * `aro diff` コマンド。中央配布物を同期した場合の差分を表示する（実ファイルは変更しない）。
 *
 * 計画 v3 §17.2 に対応する。lock file と source distribution から {@link buildSyncPlan} で
 * plan を作り、人間向け（{@link formatDiffHuman}）または JSON で出力する。
 *
 * 終了コード（§17.2）:
 *   通常モード:           0=plan成功（差分有無不問・conflictなし） / 1=validation error / 2=conflict / 3=unexpected
 *   --detailed-exitcode:  0=差分なし / 1=validation error / 2=更新あり / 3=conflict / 4=unexpected
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import type { SyncPlan } from "../types/plan.js";
import { AroError, LockFileError } from "../core/errors.js";
import { loadDistribution, resolveSourceRoot } from "../core/source.js";
import { LOCKFILE_RELATIVE_PATH, loadLockFile } from "../core/lockfile.js";
import { buildSyncPlan } from "../core/planner.js";
import { planRequiresSync } from "../core/plan-summary.js";
import { formatDiffHuman } from "./diff-format.js";

/** diff の終了コード（§17.2）。通常モードと detailed モードで意味が変わる。 */
export const DIFF_EXIT = {
  /** 差分なし、または通常モードで plan 成功（conflict なし）。 */
  ok: 0,
  /** validation error（manifest / lock / path safety / source 不在など）。 */
  validation: 1,
  /** 通常モード: conflict あり / detailed モード: 更新あり（conflict なし）。 */
  conflictOrUpdate: 2,
  /** detailed モード: conflict あり。 */
  detailedConflict: 3,
  /** 通常モード: unexpected error。 */
  unexpected: 3,
  /** detailed モード: unexpected error。 */
  detailedUnexpected: 4,
} as const;

/** diff コマンドのオプション（共通オプション + --detailed-exitcode）。 */
export interface DiffOptions extends CommonOptions {
  /** 差分なし=0 / 更新あり=2 / conflict=3 を終了コードで区別する。 */
  detailedExitcode: boolean;
}

/** executeDiff が出力に使う I/O。テストでは writer を差し替えて検証する。 */
export interface DiffIo {
  /** 標準出力への書き込み。 */
  stdout: (text: string) => void;
  /** 標準エラーへの書き込み。 */
  stderr: (text: string) => void;
  /** 色付けするか。 */
  color: boolean;
}

/**
 * plan 成功時の終了コードを決める（§17.2）。
 *
 * actionable（sync で何か書かれるか）の判定は {@link planRequiresSync} に集約し、
 * diff-format 側の up-to-date 判定と必ず同じ意味になるようにする（出力と exit code の不一致を防ぐ）。
 */
function diffSuccessExitCode(plan: SyncPlan, detailed: boolean): number {
  if (plan.hasConflicts) {
    return detailed ? DIFF_EXIT.detailedConflict : DIFF_EXIT.conflictOrUpdate;
  }
  if (!detailed) {
    return DIFF_EXIT.ok;
  }
  return planRequiresSync(plan) ? DIFF_EXIT.conflictOrUpdate : DIFF_EXIT.ok;
}

/** source 上方探索の起点。実行中モジュールの位置から ai-repo-ops source root を辿れるようにする。 */
function defaultStartDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** lock file・source distribution を解決して sync plan を作る。 */
async function computeDiffPlan(options: DiffOptions): Promise<SyncPlan> {
  const repoRoot = path.resolve(options.repo);
  const sourceRoot = await resolveSourceRoot(options.source, defaultStartDir());
  const distribution = await loadDistribution(sourceRoot, options.distribution);
  const lock = await loadLockFile(repoRoot);
  if (lock === null) {
    throw new LockFileError(
      "LOCKFILE_NOT_FOUND",
      `lock file が見つかりません: ${path.join(repoRoot, LOCKFILE_RELATIVE_PATH)}`,
      {
        hint: "対象 repo はまだ初期化されていません。先に `aro init --repo <path>` を実行してください。",
      },
    );
  }
  return buildSyncPlan({ repoRoot, distribution, lock });
}

/** エラーを人間向け 1 メッセージへ整形する（AroError は hint も添える）。 */
function formatError(error: unknown): string {
  if (error instanceof AroError) {
    const head = `ERROR ${error.message}`;
    return error.hint !== undefined ? `${head}\n      ${error.hint}` : head;
  }
  return `ERROR ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * diff を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link DiffIo} 経由で行うため、テストから writer を差し替えて検証できる。
 */
export async function executeDiff(options: DiffOptions, io: DiffIo): Promise<number> {
  const detailed = options.detailedExitcode === true;
  try {
    const plan = await computeDiffPlan(options);
    if (options.json) {
      io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      io.stdout(`${formatDiffHuman(plan, { color: io.color })}\n`);
    }
    return diffSuccessExitCode(plan, detailed);
  } catch (error) {
    io.stderr(`${formatError(error)}\n`);
    if (error instanceof AroError) {
      return DIFF_EXIT.validation;
    }
    return detailed ? DIFF_EXIT.detailedUnexpected : DIFF_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro diff` を登録する。 */
export function registerDiff(program: Command): void {
  const command = program
    .command("diff")
    .summary("中央配布物を同期した場合の差分を表示する")
    .description(
      "中央配布物を対象repoへ同期した場合に何が変わるかを表示する。実ファイルは変更しない。",
    )
    .option(
      "--detailed-exitcode",
      "差分なし=0 / 更新あり=2 / conflict=3 を終了コードで区別する（CI・automation向け）。",
      false,
    );

  addCommonOptions(command).action(async (options: DiffOptions) => {
    const code = await executeDiff(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
    });
    process.exitCode = code;
  });
}
