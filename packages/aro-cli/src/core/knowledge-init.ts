import picomatch from "picomatch";

import { KnowledgeError } from "./errors.js";
import { readFileWithinRoot, writeTextFileExclusiveWithinRoot } from "./filesystem.js";
import { KNOWLEDGE_INDEX_PATH, KNOWLEDGE_ROOT } from "./knowledge-index.js";
import type { ProjectConfig } from "./project-config.js";

export const KNOWLEDGE_OVERVIEW_PATH = `${KNOWLEDGE_ROOT}/overview.md`;
export const MANAGED_KNOWLEDGE_SCHEMA_PATH = ".ai/managed/schemas/knowledge.schema.json";
export const MANAGED_KNOWLEDGE_PROMPT_PATH = ".ai/managed/prompts/knowledge-refresh.md";

export const INITIAL_KNOWLEDGE_INDEX = `# yaml-language-server: $schema=../../managed/schemas/knowledge.schema.json
schema_version: 1
entries: []
`;

export const INITIAL_KNOWLEDGE_OVERVIEW = `# Repo Knowledge

This directory contains source-backed, repository-specific knowledge for humans and local AI agents.

- Treat code and official documentation as canonical; this knowledge is a derived index and summary.
- Record exact tracked source paths and a full verification commit in \`index.yaml\`.
- Run \`aro knowledge check --repo . --strict\` after every knowledge update.
`;

export type KnowledgeInitBlockCode =
  | "path_not_allowed"
  | "path_forbidden"
  | "managed_artifact_missing"
  | "target_exists";

export interface KnowledgeInitBlocker {
  code: KnowledgeInitBlockCode;
  path: string;
  message: string;
  hint: string;
}

export interface KnowledgeInitPlan {
  repoRoot: string;
  creates: string[];
  blockers: KnowledgeInitBlocker[];
  blocked: boolean;
}

function errnoFromCause(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  const code = (cause as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : null;
}

/**
 * exclusive-createの途中でI/Oに失敗したことを表す。
 * validation errorではなく復旧が必要なI/O errorなので、意図的にAroErrorを継承しない。
 */
export class KnowledgeInitPartialWriteError extends Error {
  readonly code = "KNOWLEDGE_INIT_PARTIAL_WRITE";
  readonly failedPath: string;
  readonly createdPaths: readonly string[];
  readonly errno: string | null;
  readonly failedPathMayBePartial: boolean;

  constructor(failedPath: string, createdPaths: readonly string[], cause: unknown) {
    super(`knowledge init failed while creating ${failedPath}`, { cause });
    this.name = "KnowledgeInitPartialWriteError";
    this.failedPath = failedPath;
    this.createdPaths = [...createdPaths];
    this.errno = errnoFromCause(cause);
    this.failedPathMayBePartial = this.errno !== "EEXIST";
  }
}

const CREATE_PATHS = [KNOWLEDGE_OVERVIEW_PATH, KNOWLEDGE_INDEX_PATH] as const;
const REQUIRED_MANAGED_PATHS = [
  MANAGED_KNOWLEDGE_SCHEMA_PATH,
  MANAGED_KNOWLEDGE_PROMPT_PATH,
] as const;

function firstMatchingPattern(patterns: readonly string[], target: string): string | undefined {
  return patterns.find((pattern) => picomatch(pattern, { dot: true, nocase: true })(target));
}

/** 書き込み前に全block条件を検査し、内容を変更せずplanを返す。 */
export async function prepareKnowledgeInit(
  repoRoot: string,
  projectConfig: ProjectConfig,
): Promise<KnowledgeInitPlan> {
  const blockers: KnowledgeInitBlocker[] = [];
  const allowed = projectConfig.ai?.allowed_paths;
  const forbidden = projectConfig.ai?.forbidden_paths ?? [];

  for (const target of CREATE_PATHS) {
    const forbiddenHit = firstMatchingPattern(forbidden, target);
    if (forbiddenHit !== undefined) {
      blockers.push({
        code: "path_forbidden",
        path: target,
        message: `knowledge pathがforbidden_pathsに一致します: ${target}`,
        hint: `一致pattern: ${forbiddenHit}`,
      });
    }
    if (allowed !== undefined && firstMatchingPattern(allowed, target) === undefined) {
      blockers.push({
        code: "path_not_allowed",
        path: target,
        message: `knowledge pathがallowed_pathsで許可されていません: ${target}`,
        hint:
          '先に.ai/project.yamlのai.allowed_pathsへ".ai/local/knowledge/**"を追加する設定PRをmergeしてください。',
      });
    }
  }

  for (const managedPath of REQUIRED_MANAGED_PATHS) {
    const content = await readFileWithinRoot(repoRoot, managedPath, "managed knowledge artifact");
    if (content === null) {
      blockers.push({
        code: "managed_artifact_missing",
        path: managedPath,
        message: `managed knowledge artifactが未導入です: ${managedPath}`,
        hint: "中央sourceを更新したうえで `aro sync --repo .` を実行してください。",
      });
    }
  }

  for (const target of CREATE_PATHS) {
    const existing = await readFileWithinRoot(repoRoot, target, "knowledge init target");
    if (existing !== null) {
      blockers.push({
        code: "target_exists",
        path: target,
        message: `knowledge init targetが既に存在します: ${target}`,
        hint: "knowledge initは既存ファイルを上書きしません。内容を確認して手動で統合してください。",
      });
    }
  }

  return {
    repoRoot,
    creates: [...CREATE_PATHS],
    blockers,
    blocked: blockers.length > 0,
  };
}

function initialContentFor(relativePath: string): string {
  if (relativePath === KNOWLEDGE_OVERVIEW_PATH) return INITIAL_KNOWLEDGE_OVERVIEW;
  if (relativePath === KNOWLEDGE_INDEX_PATH) return INITIAL_KNOWLEDGE_INDEX;
  throw new KnowledgeError("KNOWLEDGE_INIT_INTERNAL", `初期内容が未定義のpathです: ${relativePath}`);
}

/** blockedでないplanをexclusive-createで適用する。 */
export async function applyKnowledgeInit(plan: KnowledgeInitPlan): Promise<string[]> {
  if (plan.blocked) {
    throw new KnowledgeError("KNOWLEDGE_INIT_BLOCKED", "blockedなknowledge init planは適用できません。");
  }
  const created: string[] = [];
  for (const relativePath of plan.creates) {
    try {
      await writeTextFileExclusiveWithinRoot(
        plan.repoRoot,
        relativePath,
        initialContentFor(relativePath),
        "knowledge init target",
      );
    } catch (error) {
      throw new KnowledgeInitPartialWriteError(relativePath, created, error);
    }
    created.push(relativePath);
  }
  return created;
}
