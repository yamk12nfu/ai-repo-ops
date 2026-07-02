/**
 * `aro doctor` コマンド。対象 repo が ai-repo-ops に正しく参加できているかを診断する（計画 v3 §17.4）。
 *
 * 処理: repo path 解決（存在・ディレクトリ確認のみ）→ source/distribution・authoritative schema 読込 →
 * {@link runDoctor}（読み取り専用）→ human/JSON 出力 → 終了コード。
 *
 * 他コマンドと異なり「対象が Git repo であるか」自体が診断項目の 1 つであり、事前条件として
 * ブロックしない（§17.4 Repository）。そのため {@link import("../core/git.js").assertGitRepo} ではなく
 * {@link import("../core/git.js").resolveRepoRoot}（存在・ディレクトリ確認のみ）を使う。
 *
 * 終了コード（§17.4）:
 *   0: FAIL なし
 *   1: FAIL あり
 *   3: unexpected error（repo path 不正・source/manifest/schema 読込失敗など、診断レポート自体を作れない場合）
 */
import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import { runDoctor } from "../core/doctor.js";
import { resolveRepoRoot } from "../core/git.js";
import { loadDistribution, loadProjectSchema, resolveSourceRoot } from "../core/source.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { formatDoctorHuman } from "./doctor-format.js";
import { defaultSourceStartDir } from "./source-context.js";

/** doctor の終了コード（§17.4）。 */
export const DOCTOR_EXIT = {
  /** FAIL なし。 */
  ok: 0,
  /** FAIL が 1 件以上ある。 */
  hasFailures: 1,
  /** unexpected error（診断レポート自体を作れなかった）。 */
  unexpected: 3,
} as const;

/** doctor コマンドのオプション（共通オプションのみ）。 */
export type DoctorOptions = CommonOptions;

/** executeDoctor が出力に使う I/O。テストでは writer を差し替えて検証する。 */
export interface DoctorIo {
  /** 標準出力への書き込み。 */
  stdout: (text: string) => void;
  /** 標準エラーへの書き込み。 */
  stderr: (text: string) => void;
  /** 色付けするか。 */
  color: boolean;
}

/**
 * doctor を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link DoctorIo} 経由で行うため、テストから writer を差し替えて検証できる。
 */
export async function executeDoctor(options: DoctorOptions, io: DoctorIo): Promise<number> {
  try {
    const repoRoot = await resolveRepoRoot(options.repo);
    const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
    const distribution = await loadDistribution(sourceRoot, options.distribution);
    const projectSchema = await loadProjectSchema(sourceRoot);

    const report = await runDoctor({ repoRoot, distribution, projectSchema });

    if (options.json) {
      io.stdout(`${JSON.stringify({ command: "doctor", ok: !report.hasFailures, report }, null, 2)}\n`);
    } else {
      io.stdout(`${formatDoctorHuman(report, { color: io.color })}\n`);
    }
    return report.hasFailures ? DOCTOR_EXIT.hasFailures : DOCTOR_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "doctor", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return DOCTOR_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro doctor` を登録する。 */
export function registerDoctor(program: Command): void {
  const command = program
    .command("doctor")
    .summary("対象repoの状態を診断する")
    .description("対象repoが ai-repo-ops に正しく参加できているかをPASS/WARN/FAILで診断する。");

  addCommonOptions(command).action(async (options: DoctorOptions) => {
    const code = await executeDoctor(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
    });
    process.exitCode = code;
  });
}
