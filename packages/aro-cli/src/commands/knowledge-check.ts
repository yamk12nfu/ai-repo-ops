import type { Command } from "commander";

import { assertGitRepo } from "../core/git.js";
import { runKnowledgeCheck } from "../core/knowledge-check.js";
import { loadKnowledgeSchema, resolveSourceRoot } from "../core/source.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { formatKnowledgeCheckHuman } from "./knowledge-check-format.js";
import { defaultSourceStartDir } from "./source-context.js";

export const KNOWLEDGE_CHECK_EXIT = {
  ok: 0,
  failures: 1,
  unexpected: 3,
} as const;

export interface KnowledgeCheckOptions {
  repo: string;
  source?: string | undefined;
  strict: boolean;
  json: boolean;
  color: boolean;
}

export interface KnowledgeCheckIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

export async function executeKnowledgeCheck(
  options: KnowledgeCheckOptions,
  io: KnowledgeCheckIo,
): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
    const knowledgeSchema = await loadKnowledgeSchema(sourceRoot);
    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: options.strict });
    if (options.json) {
      io.stdout(
        `${JSON.stringify(
          {
            command: "knowledge check",
            ok: !report.hasFailures,
            strict: options.strict,
            report,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(`${formatKnowledgeCheckHuman(report, { color: io.color })}\n`);
    }
    return report.hasFailures ? KNOWLEDGE_CHECK_EXIT.failures : KNOWLEDGE_CHECK_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(
        `${JSON.stringify(
          { command: "knowledge check", ok: false, error: errorToJson(error) },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return KNOWLEDGE_CHECK_EXIT.unexpected;
  }
}

function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro knowledge check` を親knowledge commandへ登録する。 */
export function registerKnowledgeCheck(parent: Command): void {
  parent
    .command("check")
    .summary("knowledgeの構造・根拠・鮮度を検証する")
    .description(".ai/local/knowledge/index.yamlと根拠sourceを決定的に検証する。")
    .option("--repo <path>", "対象repoのpath。", ".")
    .option("--source <path>", "ai-repo-ops sourceのpath。")
    .option("--strict", "stale knowledgeもFAILにする。", false)
    .option("--json", "JSONで結果を出力する。", false)
    .option("--no-color", "色なしで出力する。")
    .action(async (options: KnowledgeCheckOptions) => {
      const code = await executeKnowledgeCheck(options, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        color: resolveColor(options.color),
      });
      process.exitCode = code;
    });
}
