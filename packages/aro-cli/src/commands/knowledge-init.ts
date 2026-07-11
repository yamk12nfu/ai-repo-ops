import path from "node:path";

import type { Command } from "commander";

import { AroError, KnowledgeError, ProjectConfigError } from "../core/errors.js";
import { assertGitRepo } from "../core/git.js";
import { getMergeBase, readFileAtRevision } from "../core/git-diff.js";
import { validateJsonSchema } from "../core/json-schema.js";
import {
  applyKnowledgeInit,
  INITIAL_KNOWLEDGE_INDEX,
  KnowledgeInitPartialWriteError,
  prepareKnowledgeInit,
  type KnowledgeInitPlan,
} from "../core/knowledge-init.js";
import { PROJECT_YAML_PATH } from "../core/manifest.js";
import { parseProjectConfig } from "../core/project-config.js";
import { loadKnowledgeSchema, resolveSourceRoot } from "../core/source.js";
import { parseYaml } from "../core/yaml.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { defaultSourceStartDir } from "./source-context.js";

export const KNOWLEDGE_INIT_EXIT = {
  ok: 0,
  validation: 1,
  blocked: 2,
  unexpected: 3,
} as const;

export interface KnowledgeInitOptions {
  repo: string;
  base: string;
  source?: string | undefined;
  dryRun: boolean;
  json: boolean;
  color: boolean;
  launcher?: string | undefined;
}

export interface KnowledgeInitIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
}

export interface KnowledgeInitDependencies {
  applyKnowledgeInit: typeof applyKnowledgeInit;
}

const DEFAULT_DEPENDENCIES: KnowledgeInitDependencies = {
  applyKnowledgeInit,
};

export async function executeKnowledgeInit(
  options: KnowledgeInitOptions,
  io: KnowledgeInitIo,
  dependencies: KnowledgeInitDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
    const knowledgeSchema = await loadKnowledgeSchema(sourceRoot);
    const schemaIssues = validateJsonSchema(knowledgeSchema, parseYaml(INITIAL_KNOWLEDGE_INDEX));
    if (schemaIssues.length > 0) {
      throw new KnowledgeError(
        "KNOWLEDGE_INITIAL_INDEX_INVALID",
        `組み込みinitial knowledge indexがauthoritative schemaに適合しません: ${schemaIssues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    // feature branchやworking treeの設定変更で自己許可しないよう、baseとHEADのmerge-baseを読む。
    const authorizationRevision = await getMergeBase(repoRoot, options.base);
    const configText = await readFileAtRevision(repoRoot, authorizationRevision, PROJECT_YAML_PATH);
    if (configText === null) {
      throw new ProjectConfigError(
        "PROJECT_CONFIG_NOT_FOUND",
        `base（merge-base: ${authorizationRevision}）に${PROJECT_YAML_PATH}が存在しません。`,
        {
          hint:
            "既存repoでは設定PRを先にmergeして --base origin/main を指定してください。" +
            "新規repoの初期commit直後だけは --base HEAD を指定できます。",
        },
      );
    }
    const projectConfig = parseProjectConfig(
      configText,
      `${authorizationRevision}:${PROJECT_YAML_PATH}`,
    );
    const plan = await prepareKnowledgeInit(repoRoot, projectConfig);
    if (plan.blocked) {
      outputBlocked(plan, authorizationRevision, options, io);
      return KNOWLEDGE_INIT_EXIT.blocked;
    }

    if (options.dryRun) {
      if (options.json) {
        io.stdout(
          `${JSON.stringify(
            {
              command: "knowledge init",
              ok: true,
              dryRun: true,
              base: options.base,
              authorizationRevision,
              creates: plan.creates,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        io.stdout(`${formatInitPlan(plan)}\n\n(dry-run: ファイルは書き込まれていません)\n`);
      }
      return KNOWLEDGE_INIT_EXIT.ok;
    }

    const created = await dependencies.applyKnowledgeInit(plan);
    if (options.json) {
      io.stdout(
        `${JSON.stringify(
          { command: "knowledge init", ok: true, base: options.base, authorizationRevision, created },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(
        `${formatCreated(created, authorizationRevision, options.launcher ?? "aro", repoRoot)}\n`,
      );
    }
    return KNOWLEDGE_INIT_EXIT.ok;
  } catch (error) {
    if (error instanceof KnowledgeInitPartialWriteError) {
      if (options.json) {
        io.stderr(`${JSON.stringify(partialWriteErrorToJson(error), null, 2)}\n`);
      } else {
        io.stderr(`${formatPartialWriteError(error)}\n`);
      }
      return KNOWLEDGE_INIT_EXIT.unexpected;
    }
    if (options.json) {
      io.stderr(
        `${JSON.stringify(
          { command: "knowledge init", ok: false, error: errorToJson(error) },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return error instanceof AroError ? KNOWLEDGE_INIT_EXIT.validation : KNOWLEDGE_INIT_EXIT.unexpected;
  }
}

function formatInitPlan(plan: KnowledgeInitPlan): string {
  return [
    "Knowledge files to create:",
    ...plan.creates.map((relativePath) => `  + ${relativePath}`),
  ].join("\n");
}

function formatCreated(
  created: readonly string[],
  authorizationRevision: string,
  launcher: string,
  repoRoot: string,
): string {
  const repoArgument = quotePosixShellArg(repoRoot);
  const checkCommand = `${launcher} knowledge check --repo ${repoArgument} --strict`;
  const guardCommand = `${launcher} guard --repo ${repoArgument} --base ${authorizationRevision}`;
  return [
    "Created:",
    ...created.map((relativePath) => `  + ${relativePath}`),
    "",
    "Done.",
    "",
    "Next steps:",
    "  1. 対象repoをCodexまたはClaude Codeで開き、次の範囲をそのまま入力します:",
    "     ----- prompt start -----",
    "     .ai/managed/prompts/knowledge-refresh.md を読み、リポジトリを調査して初回Repo Knowledgeを1単位作成してください。",
    "     初回は変化しにくい正式文書を根拠とし、個別タスクや作業ログは除外してください。",
    "     次の完全なコマンドでknowledgeを検証してください:",
    `     ${checkCommand}`,
    "     未commitの変更はaro guardの検証対象外です。knowledge check後に差分を提示してください。",
    "     人間が差分を確認してcommitした後、次の完全なコマンドでguardを実行してください:",
    `     ${guardCommand}`,
    "     ----- prompt end -----",
    "  2. AIの更新後、未commitのままknowledgeを検証します:",
    `     ${checkCommand}`,
    "  3. 人間が差分を確認してcommitした後、guardを実行します:",
    `     ${guardCommand}`,
    "  4. guardが成功したらPRを作成してください。自動mergeはしません。",
    "",
    "  Note: aroがPATHにない場合は、このinitに使った起動方法で同じsubcommandを実行してください。",
  ].join("\n");
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatCliLauncher(nodeExecutable: string, scriptPath?: string): string {
  if (scriptPath === undefined) return "aro";
  return `${quotePosixShellArg(nodeExecutable)} ${quotePosixShellArg(scriptPath)}`;
}

function outputBlocked(
  plan: KnowledgeInitPlan,
  authorizationRevision: string,
  options: KnowledgeInitOptions,
  io: KnowledgeInitIo,
): void {
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          command: "knowledge init",
          ok: false,
          reason: "blocked",
          base: options.base,
          authorizationRevision,
          blockers: plan.blockers,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [
    "ERROR knowledge init is blocked.",
    `  Authorization config: base（merge-base: ${authorizationRevision}）`,
  ];
  for (const blocker of plan.blockers) {
    lines.push(`  ! ${blocker.message}`);
    lines.push(`    ${blocker.hint}`);
  }
  io.stderr(`${lines.join("\n")}\n`);
}

function errorCauseMessage(error: KnowledgeInitPartialWriteError): string {
  return error.cause instanceof Error ? error.cause.message : String(error.cause);
}

function errorCauseSummary(error: KnowledgeInitPartialWriteError): string {
  const message = errorCauseMessage(error);
  return error.errno === null || message.includes(error.errno)
    ? message
    : `${error.errno}: ${message}`;
}

function partialWriteErrorToJson(error: KnowledgeInitPartialWriteError): object {
  return {
    command: "knowledge init",
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      failedPath: error.failedPath,
      createdPaths: [...error.createdPaths],
      errno: error.errno,
      failedPathMayBePartial: error.failedPathMayBePartial,
      cause: errorCauseMessage(error),
    },
    recovery: {
      removePaths: [...error.createdPaths],
      inspectPaths: [error.failedPath],
    },
  };
}

function formatPartialWriteError(error: KnowledgeInitPartialWriteError): string {
  const lines = [
    `ERROR ${error.code}: ${error.message}`,
    `      ${errorCauseSummary(error)}`,
    "",
    "Failed path to inspect:",
    `  ${error.failedPath}`,
  ];
  if (error.failedPathMayBePartial) {
    lines.push("  This path may exist and may contain partial content; inspect it before retrying.");
  } else {
    lines.push("  EEXIST: this path may belong to another writer; do not remove it automatically.");
  }
  lines.push(
    "",
    "Created paths before failure:",
  );
  if (error.createdPaths.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(...error.createdPaths.map((relativePath) => `  ${relativePath}`));
  }
  lines.push("", "Suggested recovery:", `  Inspect: ${error.failedPath}`);
  if (error.createdPaths.length === 0) {
    lines.push("  （復旧対象のpathはありません）");
  } else {
    lines.push(`  rm -f -- ${error.createdPaths.map((relativePath) => `'${relativePath}'`).join(" ")}`);
  }
  return lines.join("\n");
}

function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro knowledge init` を親knowledge commandへ登録する。 */
export function registerKnowledgeInit(parent: Command): void {
  parent
    .command("init")
    .summary("knowledge領域を初期化する")
    .description(".ai/local/knowledgeにindexとoverviewを既存ファイル非上書きで作成する。")
    .requiredOption("--base <ref>", "認可設定を読むbase ref（baseとHEADのmerge-base）。")
    .option("--repo <path>", "対象repoのpath。", ".")
    .option("--source <path>", "ai-repo-ops sourceのpath。")
    .option("--dry-run", "作成予定だけを表示する。", false)
    .option("--json", "JSONで結果を出力する。", false)
    .option("--no-color", "色なしで出力する。")
    .action(async (options: KnowledgeInitOptions) => {
      const scriptPath = process.argv[1];
      const code = await executeKnowledgeInit(
        {
          ...options,
          launcher: formatCliLauncher(
            process.execPath,
            scriptPath === undefined ? undefined : path.resolve(scriptPath),
          ),
        },
        {
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
          color: resolveColor(options.color),
        },
      );
      process.exitCode = code;
    });
}
