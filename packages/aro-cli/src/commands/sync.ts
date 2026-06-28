import type { Command } from "commander";

import { addCommonOptions, notImplemented } from "../common-options.js";

/** `aro sync` を登録する（実装は Phase 5）。 */
export function registerSync(program: Command): void {
  const command = program
    .command("sync")
    .summary("中央配布物を対象repoへ同期する")
    .description(
      "中央配布物を対象repoへ適用する。conflictが1つでもあれば一切変更せずabortする。",
    );

  addCommonOptions(command).action(() => {
    notImplemented("sync", "Phase 5");
  });
}
