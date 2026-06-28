import type { Command } from "commander";

import { addCommonOptions, notImplemented } from "../common-options.js";

/** `aro diff` を登録する（実装は Phase 4）。 */
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

  addCommonOptions(command).action(() => {
    notImplemented("diff", "Phase 4");
  });
}
