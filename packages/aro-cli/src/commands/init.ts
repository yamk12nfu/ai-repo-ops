import type { Command } from "commander";

import { addCommonOptions, notImplemented } from "../common-options.js";

/** `aro init` を登録する（実装は Phase 5）。 */
export function registerInit(program: Command): void {
  const command = program
    .command("init")
    .summary("対象repoにAI運用基盤ファイルを初回展開する")
    .description(
      "対象repoに .ai/ と .github/workflows/ などのAI運用基盤ファイルを初回展開し、lock fileを生成する。",
    );

  addCommonOptions(command).action(() => {
    notImplemented("init", "Phase 5");
  });
}
