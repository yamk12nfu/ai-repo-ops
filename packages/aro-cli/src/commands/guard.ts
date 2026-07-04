/**
 * `aro guard` コマンド。`<base>...HEAD`（merge-base 比較）の diff を policies に照らして検証する
 * （docs/plans/03-guard-and-improve-loop.md Stage 1-1。未 merge の場合はこのファイルと呼び出し元の
 * 指示を仕様の正とする）。
 *
 * 処理: repo/git 確認 → project.yaml / risk_level 対応 policy の読込 → git diff 取得 →
 * {@link runGuard}（読み取り専用）→ human/JSON 出力 → 終了コード。
 *
 * 読み取り専用（diff を読むだけ。doctor と同じ思想）。改善ループ（Stage 2）が abort 判定に使う
 * 前提のコマンドのため、実ファイルは一切変更しない。
 *
 * 終了コード（`GUARD_EXIT`。doctor と同型）:
 *   0: 違反なし
 *   1: 違反あり
 *   3: unexpected error（project.yaml/policy が読めない・git repo でない・base ref が解決できない等、
 *      検証に必要な入力が揃わず判定不能な場合）
 *
 * 違反判定そのものは例外を投げず {@link runGuard} の戻り値で返るため、catch に落ちるのは
 * 「判定不能」な入力エラーのみになる（doctor と同じ思想。設定の妥当性検証自体は doctor の仕事）。
 */
import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import { assertGitRepo } from "../core/git.js";
import { getChangedFiles } from "../core/git-diff.js";
import { runGuard, type GuardReport } from "../core/guard.js";
import { loadPolicy } from "../core/policy.js";
import { loadProjectConfig } from "../core/project-config.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { formatGuardHuman } from "./guard-format.js";

/** guard の終了コード（doctor と同型）。 */
export const GUARD_EXIT = {
  /** 違反なし。 */
  ok: 0,
  /** 違反が 1 件以上ある。 */
  violations: 1,
  /** unexpected error（判定に必要な入力が読めず、検証自体を実行できなかった）。 */
  unexpected: 3,
} as const;

/** guard コマンドのオプション（共通オプション + 必須の `--base`）。 */
export interface GuardOptions extends CommonOptions {
  /** 比較対象の base ref（`<base>...HEAD` の merge-base 比較）。 */
  base: string;
}

/** executeGuard が出力に使う I/O。テストでは writer を差し替えて検証する。 */
export interface GuardIo {
  /** 標準出力への書き込み。 */
  stdout: (text: string) => void;
  /** 標準エラーへの書き込み。 */
  stderr: (text: string) => void;
  /** 色付けするか。 */
  color: boolean;
}

/**
 * guard を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link GuardIo} 経由で行うため、テストから writer を差し替えて検証できる。
 */
export async function executeGuard(options: GuardOptions, io: GuardIo): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const projectConfig = await loadProjectConfig(repoRoot);
    const policy = await loadPolicy(repoRoot, projectConfig.project.risk_level);
    const changedFiles = await getChangedFiles(repoRoot, options.base);

    const report: GuardReport = runGuard({ changedFiles, projectConfig, policy });

    if (options.json) {
      io.stdout(
        `${JSON.stringify({ command: "guard", ok: !report.hasViolations, base: options.base, report }, null, 2)}\n`,
      );
    } else {
      io.stdout(`${formatGuardHuman(report, { base: options.base, color: io.color })}\n`);
    }
    return report.hasViolations ? GUARD_EXIT.violations : GUARD_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "guard", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return GUARD_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro guard` を登録する。 */
export function registerGuard(program: Command): void {
  const command = program
    .command("guard")
    .summary("PR由来の変更がpoliciesに違反していないかを検証する")
    .description(
      "<base>...HEAD（merge-base比較）のdiffを検証し、forbidden_paths / allowed_paths / change_limits等のpolicies違反を検出する。読み取り専用。",
    )
    .requiredOption("--base <ref>", "比較対象のbase ref（<base>...HEADのmerge-base比較）。");

  addCommonOptions(command).action(async (options: GuardOptions) => {
    const code = await executeGuard(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
    });
    process.exitCode = code;
  });
}
