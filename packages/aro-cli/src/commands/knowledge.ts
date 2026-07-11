import type { Command } from "commander";

import { registerKnowledgeCheck } from "./knowledge-check.js";
import { registerKnowledgeInit } from "./knowledge-init.js";

/** repo 固有 knowledge の初期化・検証コマンド群を登録する。 */
export function registerKnowledge(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .summary("repo固有knowledgeを初期化・検証する")
    .description(".ai/local/knowledge 配下のrepo固有knowledgeを安全に管理する。");

  registerKnowledgeInit(knowledge);
  registerKnowledgeCheck(knowledge);
}
