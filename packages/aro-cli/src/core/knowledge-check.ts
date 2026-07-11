import path from "node:path";

import picomatch from "picomatch";

import { readFileWithinRoot } from "./filesystem.js";
import {
  inspectKnowledgeSourceGit,
  isRegularKnowledgeSourceEntry,
} from "./knowledge-git.js";
import {
  KNOWLEDGE_INDEX_PATH,
  KNOWLEDGE_ROOT,
  parseKnowledgeIndexValue,
  type KnowledgeEntry,
  type KnowledgeIndex,
} from "./knowledge-index.js";
import { validateJsonSchema } from "./json-schema.js";
import { parseYaml } from "./yaml.js";

export type KnowledgeFindingStatus = "pass" | "warn" | "fail";

export interface KnowledgeFinding {
  id: string;
  status: KnowledgeFindingStatus;
  entryId?: string;
  path?: string;
  message: string;
  hint?: string;
}

export interface KnowledgeSummary {
  entries: number;
  passed: number;
  warned: number;
  failed: number;
  stale: number;
}

export interface KnowledgeReport {
  repoRoot: string;
  strict: boolean;
  findings: KnowledgeFinding[];
  summary: KnowledgeSummary;
  hasWarnings: boolean;
  hasFailures: boolean;
}

export interface RunKnowledgeCheckInput {
  repoRoot: string;
  knowledgeSchema: unknown;
  strict: boolean;
}

const FORBIDDEN_SOURCE_PATTERNS = [
  ".env",
  "**/.env",
  ".env.*",
  "**/.env.*",
  "secrets/**",
  "**/secrets/**",
  ".git/**",
  "**/.git/**",
  ".ai/**",
  "**/.ai/**",
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
] as const;

const forbiddenSourceMatchers = FORBIDDEN_SOURCE_PATTERNS.map((pattern) => ({
  pattern,
  isMatch: picomatch(pattern, { dot: true, nocase: true }),
}));

function forbiddenSourcePattern(sourcePath: string): string | undefined {
  return forbiddenSourceMatchers.find((matcher) => matcher.isMatch(sourcePath))?.pattern;
}

type TextReadResult =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "not-text" }
  | { kind: "read-error"; error: unknown };

async function readUtf8TextWithinRoot(
  repoRoot: string,
  relativePath: string,
  label: string,
): Promise<TextReadResult> {
  let buffer: Buffer | null;
  try {
    buffer = await readFileWithinRoot(repoRoot, relativePath, label);
  } catch (error) {
    return { kind: "read-error", error };
  }
  if (buffer === null) return { kind: "missing" };
  if (buffer.includes(0)) return { kind: "not-text" };
  try {
    return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { kind: "not-text" };
  }
}

function finalizeReport(
  repoRoot: string,
  strict: boolean,
  entries: number,
  findings: KnowledgeFinding[],
): KnowledgeReport {
  const summary: KnowledgeSummary = {
    entries,
    passed: findings.filter((finding) => finding.status === "pass").length,
    warned: findings.filter((finding) => finding.status === "warn").length,
    failed: findings.filter((finding) => finding.status === "fail").length,
    stale: findings.filter((finding) => finding.id === "source.stale").length,
  };
  return {
    repoRoot,
    strict,
    findings,
    summary,
    hasWarnings: summary.warned > 0,
    hasFailures: summary.failed > 0,
  };
}

function fail(
  id: string,
  message: string,
  context: { entryId?: string; path?: string; hint?: string } = {},
): KnowledgeFinding {
  return { id, status: "fail", message, ...context };
}

function pass(
  id: string,
  message: string,
  context: { entryId?: string; path?: string } = {},
): KnowledgeFinding {
  return { id, status: "pass", message, ...context };
}

async function checkDocument(
  repoRoot: string,
  entry: KnowledgeEntry,
  findings: KnowledgeFinding[],
): Promise<void> {
  const relativePath = `${KNOWLEDGE_ROOT}/${entry.document}`;
  const result = await readUtf8TextWithinRoot(repoRoot, relativePath, "knowledge document");
  if (result.kind === "read-error") {
    findings.push(
      fail("document.read", `knowledge documentを安全に読めません: ${entry.document}`, {
        entryId: entry.id,
        path: relativePath,
        hint: result.error instanceof Error ? result.error.message : String(result.error),
      }),
    );
    return;
  }
  if (result.kind === "missing") {
    findings.push(
      fail("document.exists", `knowledge documentが存在しません: ${entry.document}`, {
        entryId: entry.id,
        path: relativePath,
      }),
    );
    return;
  }
  if (result.kind === "not-text") {
    findings.push(
      fail("document.text", `knowledge documentがUTF-8テキストではありません: ${entry.document}`, {
        entryId: entry.id,
        path: relativePath,
      }),
    );
    return;
  }
  findings.push(
    pass("document.exists", `knowledge documentが存在します: ${entry.document}`, {
      entryId: entry.id,
      path: relativePath,
    }),
  );
}

async function checkSource(
  repoRoot: string,
  entry: KnowledgeEntry,
  sourcePath: string,
  strict: boolean,
  findings: KnowledgeFinding[],
): Promise<void> {
  const forbidden = forbiddenSourcePattern(sourcePath);
  if (forbidden !== undefined) {
    findings.push(
      fail("source.forbidden", `knowledge sourceに禁止pathは使えません: ${sourcePath}`, {
        entryId: entry.id,
        path: sourcePath,
        hint: `built-in forbidden pattern: ${forbidden}`,
      }),
    );
    return;
  }

  const state = await inspectKnowledgeSourceGit(repoRoot, sourcePath, entry.verified_at_commit);
  if (state.headEntry === null) {
    findings.push(
      fail("source.tracked", `knowledge sourceがHEADでGit追跡されていません: ${sourcePath}`, {
        entryId: entry.id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (!isRegularKnowledgeSourceEntry(state.headEntry)) {
    findings.push(
      fail(
        "source.git-object",
        `knowledge sourceはHEAD上の通常blobである必要があります: ${sourcePath}`,
        {
          entryId: entry.id,
          path: sourcePath,
          hint: `Git tree entry: mode=${state.headEntry.mode}, type=${state.headEntry.type}`,
        },
      ),
    );
    return;
  }
  if (state.commitState === "missing") {
    findings.push(
      fail("provenance.commit", `verification commitが存在しません: ${entry.verified_at_commit}`, {
        entryId: entry.id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (state.commitState === "not-ancestor") {
    findings.push(
      fail("provenance.ancestor", `verification commitがHEADの祖先ではありません: ${entry.verified_at_commit}`, {
        entryId: entry.id,
        path: sourcePath,
        hint: "rebase後は現在の履歴で根拠を再検証してください。",
      }),
    );
    return;
  }
  if (state.verifiedEntry === null) {
    findings.push(
      fail("provenance.source-at-commit", `verification commitにsourceが存在しません: ${sourcePath}`, {
        entryId: entry.id,
        path: sourcePath,
      }),
    );
  } else if (!isRegularKnowledgeSourceEntry(state.verifiedEntry)) {
    findings.push(
      fail(
        "provenance.source-git-object",
        `verification commitのsourceは通常blobである必要があります: ${sourcePath}`,
        {
          entryId: entry.id,
          path: sourcePath,
          hint: `Git tree entry: mode=${state.verifiedEntry.mode}, type=${state.verifiedEntry.type}`,
        },
      ),
    );
    return;
  }

  if (state.verifiedEntry !== null) {
    const result = await readUtf8TextWithinRoot(repoRoot, sourcePath, "knowledge source");
    if (result.kind === "read-error") {
      findings.push(
        fail("source.read", `knowledge sourceを安全に読めません: ${sourcePath}`, {
          entryId: entry.id,
          path: sourcePath,
          hint: result.error instanceof Error ? result.error.message : String(result.error),
        }),
      );
      return;
    }
    if (result.kind === "missing") {
      findings.push(
        fail("source.exists", `knowledge sourceが存在しません: ${sourcePath}`, {
          entryId: entry.id,
          path: sourcePath,
        }),
      );
      return;
    }
    if (result.kind === "not-text") {
      findings.push(
        fail("source.text", `knowledge sourceがUTF-8テキストではありません: ${sourcePath}`, {
          entryId: entry.id,
          path: sourcePath,
        }),
      );
      return;
    }
  }

  if (state.stale === true) {
    findings.push({
      id: "source.stale",
      status: strict ? "fail" : "warn",
      entryId: entry.id,
      path: sourcePath,
      message: `verification commit以降にknowledge sourceが変更されています: ${sourcePath}`,
      hint: "sourceを再確認し、knowledgeとverified_at_commitを更新してください。",
    });
    return;
  }
  if (state.verifiedEntry !== null) {
    findings.push(
      pass("source.fresh", `knowledge sourceは検証commitから変更されていません: ${sourcePath}`, {
        entryId: entry.id,
        path: sourcePath,
      }),
    );
  }
}

/** repo 固有knowledgeを決定的に検証する。 */
export async function runKnowledgeCheck(input: RunKnowledgeCheckInput): Promise<KnowledgeReport> {
  const repoRoot = path.resolve(input.repoRoot);
  const findings: KnowledgeFinding[] = [];
  const indexRead = await readUtf8TextWithinRoot(
    repoRoot,
    KNOWLEDGE_INDEX_PATH,
    "knowledge index",
  );
  if (indexRead.kind === "read-error") {
    findings.push(
      fail("index.read", `knowledge indexを安全に読めません: ${KNOWLEDGE_INDEX_PATH}`, {
        path: KNOWLEDGE_INDEX_PATH,
        hint:
          indexRead.error instanceof Error ? indexRead.error.message : String(indexRead.error),
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }
  if (indexRead.kind === "missing") {
    findings.push(
      fail("index.exists", `knowledge indexが存在しません: ${KNOWLEDGE_INDEX_PATH}`, {
        path: KNOWLEDGE_INDEX_PATH,
        hint:
          "`aro knowledge init --repo . --base <trusted-ref>` を実行してください。" +
          "既存repoでは例として --base origin/main を指定します。",
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }
  findings.push(pass("index.exists", `knowledge indexが存在します: ${KNOWLEDGE_INDEX_PATH}`, { path: KNOWLEDGE_INDEX_PATH }));

  if (indexRead.kind === "not-text") {
    findings.push(fail("index.text", "knowledge indexがUTF-8テキストではありません。", { path: KNOWLEDGE_INDEX_PATH }));
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }
  let rawIndex: unknown;
  try {
    rawIndex = parseYaml(indexRead.text);
  } catch (error) {
    findings.push(
      fail("index.parse", "knowledge indexのYAML parseに失敗しました。", {
        path: KNOWLEDGE_INDEX_PATH,
        hint: error instanceof Error ? error.message : String(error),
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }

  const schemaIssues = validateJsonSchema(input.knowledgeSchema, rawIndex);
  if (schemaIssues.length > 0) {
    findings.push(
      fail("index.schema", "knowledge indexがauthoritative schemaに適合しません。", {
        path: KNOWLEDGE_INDEX_PATH,
        hint: schemaIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }

  let index: KnowledgeIndex;
  try {
    index = parseKnowledgeIndexValue(rawIndex, KNOWLEDGE_INDEX_PATH);
  } catch (error) {
    findings.push(
      fail("index.semantic", "knowledge indexの意味的検証に失敗しました。", {
        path: KNOWLEDGE_INDEX_PATH,
        hint: error instanceof Error ? error.message : String(error),
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }
  findings.push(pass("index.schema", "knowledge index schemaは有効です。", { path: KNOWLEDGE_INDEX_PATH }));

  if (index.entries.length === 0) {
    findings.push({
      id: "entries.empty",
      status: "warn",
      message: "knowledge entryがまだありません。",
      hint: ".ai/managed/prompts/knowledge-refresh.md に従って最初のknowledgeを作成してください。",
    });
  }

  for (const entry of index.entries) {
    await checkDocument(repoRoot, entry, findings);
    for (const source of entry.sources) {
      await checkSource(repoRoot, entry, source.path, input.strict, findings);
    }
  }

  return finalizeReport(repoRoot, input.strict, index.entries.length, findings);
}
