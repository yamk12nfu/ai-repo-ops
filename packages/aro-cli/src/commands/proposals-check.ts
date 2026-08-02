import type { Command } from "commander";

import { assertGitRepo } from "../core/git.js";
import { runProposalsCheck } from "../core/proposals-check.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { formatProposalsCheckHuman } from "./proposals-check-format.js";

export const PROPOSALS_CHECK_EXIT = {
  ok: 0,
  failures: 1,
  unexpected: 3,
} as const;

export interface ProposalsCheckOptions {
  repo: string;
  strict: boolean;
  json: boolean;
  color: boolean;
}

export interface ProposalsCheckIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

export async function executeProposalsCheck(
  options: ProposalsCheckOptions,
  io: ProposalsCheckIo,
): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const report = await runProposalsCheck({ repoRoot, strict: options.strict });
    if (options.json) {
      io.stdout(
        `${JSON.stringify(
          {
            command: "proposals check",
            ok: !report.hasFailures,
            strict: options.strict,
            report,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(`${formatProposalsCheckHuman(report, { color: io.color })}\n`);
    }
    return report.hasFailures ? PROPOSALS_CHECK_EXIT.failures : PROPOSALS_CHECK_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(
        `${JSON.stringify(
          { command: "proposals check", ok: false, error: errorToJson(error) },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return PROPOSALS_CHECK_EXIT.unexpected;
  }
}

function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro proposals check` を親proposals commandへ登録する。 */
export function registerProposalsCheck(parent: Command): void {
  parent
    .command("check")
    .summary("proposalの形式・根拠・鮮度を検証する")
    .description(".ai/local/proposals 配下の提案を読み取り専用で決定的に検証する。")
    .option("--repo <path>", "対象repoのpath。", ".")
    .option("--strict", "stale proposalもFAILにする。", false)
    .option("--json", "JSONで結果を出力する。", false)
    .option("--no-color", "色なしで出力する。")
    .action(async (options: ProposalsCheckOptions) => {
      const code = await executeProposalsCheck(options, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        color: resolveColor(options.color),
      });
      process.exitCode = code;
    });
}
