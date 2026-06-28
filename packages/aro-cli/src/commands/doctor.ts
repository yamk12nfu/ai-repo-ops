import type { Command } from "commander";

import { addCommonOptions, notImplemented } from "../common-options.js";

/** `aro doctor` を登録する（実装は Phase 6）。 */
export function registerDoctor(program: Command): void {
  const command = program
    .command("doctor")
    .summary("対象repoの状態を診断する")
    .description(
      "対象repoが ai-repo-ops に正しく参加できているかをPASS/WARN/FAILで診断する。",
    );

  addCommonOptions(command).action(() => {
    notImplemented("doctor", "Phase 6");
  });
}
