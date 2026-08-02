import type { Command } from "commander";

import { registerProposalsCheck } from "./proposals-check.js";

/** repo 固有 proposal の検証コマンド群を登録する。 */
export function registerProposals(program: Command): void {
  const proposals = program
    .command("proposals")
    .summary("repo固有proposalを検証する")
    .description(".ai/local/proposals 配下の提案（AIが提案し人間が採否を決める）を安全に検証する。");

  registerProposalsCheck(proposals);
}
