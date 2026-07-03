import type { Command } from "commander";

/**
 * 全コマンド共通のオプション値。
 * v3 計画 §8.1 の共通オプションに対応する。
 */
export interface CommonOptions {
  /** 対象 repo の path。省略時はカレントディレクトリ。 */
  repo: string;
  /** distribution 名。デフォルト base。 */
  distribution: string;
  /**
   * ai-repo-ops source の path。MVP では local path のみ。
   * exactOptionalPropertyTypes 下で commander の `.opts()`（値未指定時 undefined）を
   * そのまま受けられるよう、undefined を許容する optional は明示的に `| undefined` を付ける。
   * 以後 manifest / lockfile の型定義でもこの規約に従う。
   */
  source?: string | undefined;
  /** 実ファイル変更を行わない。 */
  dryRun: boolean;
  /** JSON で結果を出力する。 */
  json: boolean;
  /** 詳細ログを出力する。 */
  verbose: boolean;
  /** 色付き出力するか（`--no-color` で false）。 */
  color: boolean;
}

/** コマンドに共通オプションを追加する。 */
export function addCommonOptions(command: Command): Command {
  return command
    .option("--repo <path>", "対象repoのpath。省略時はカレントディレクトリ。", ".")
    .option("--distribution <name>", "distribution名。", "base")
    .option("--source <path>", "ai-repo-ops sourceのpath。MVPではlocal pathのみ。")
    .option("--dry-run", "実ファイル変更を行わない。", false)
    .option("--json", "JSONで結果を出力する。", false)
    .option("--verbose", "詳細ログを出力する。", false)
    .option("--no-color", "色なしで出力する。");
}

