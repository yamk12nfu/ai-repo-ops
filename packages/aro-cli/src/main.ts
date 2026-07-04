import { Command } from "commander";

import { registerInit } from "./commands/init.js";
import { registerDiff } from "./commands/diff.js";
import { registerSync } from "./commands/sync.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerGuard } from "./commands/guard.js";

/** aro CLI のバージョン。manifest.version とは独立した CLI 自身のバージョン。 */
export const ARO_CLI_VERSION = "0.1.0";

/**
 * aro のコマンドツリーを構築する。
 *
 * import 時の副作用を避けるため、プログラムの生成と実行を分離している。
 * テストからは {@link buildProgram} を直接呼び、`process.exit` を経由せずに
 * help / バージョン / 登録済みコマンドを検証できる。
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("aro")
    .description("ai-repo-ops — AI運用基盤を複数リポジトリへ安全に配布・更新・検証するツール")
    .version(ARO_CLI_VERSION, "-V, --version", "バージョンを表示する")
    .showHelpAfterError("(`aro --help` でヘルプを表示します)");

  registerInit(program);
  registerDiff(program);
  registerSync(program);
  registerDoctor(program);
  registerGuard(program);

  return program;
}

/**
 * 引数を解釈して aro を実行する。
 * @param argv `process.argv` 互換の配列（先頭2要素は node 実行パスとスクリプトパス）。
 */
export async function run(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync(argv as string[]);
}
