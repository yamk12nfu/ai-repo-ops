import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitTreeError, KnowledgeError } from "./errors.js";
import {
  FULL_GIT_OBJECT_ID_RE,
  isRegularGitTreeEntry,
  readTreeEntryAtRevision,
  type GitTreeEntry,
} from "./git-tree.js";
import { assertSafeRelativePath } from "./paths.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type KnowledgeCommitState = "missing" | "not-ancestor" | "ancestor";

export type KnowledgeGitTreeEntry = GitTreeEntry;

export interface KnowledgeSourceGitState {
  commitState: KnowledgeCommitState;
  headEntry: KnowledgeGitTreeEntry | null;
  verifiedEntry: KnowledgeGitTreeEntry | null;
  trackedAtHead: boolean;
  existsAtVerifiedCommit: boolean | null;
  stale: boolean | null;
}

function numericExitCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

async function gitProbe(repoRoot: string, args: readonly string[]): Promise<number> {
  try {
    await execFileAsync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    return 0;
  } catch (error) {
    const code = numericExitCode(error);
    if (code !== undefined) return code;
    throw new KnowledgeError("KNOWLEDGE_GIT_FAILED", `git ${args[0] ?? "command"} の実行に失敗しました。`, {
      hint: "対象repoのGit状態を確認してください。",
      cause: error,
    });
  }
}

async function objectExists(repoRoot: string, objectName: string): Promise<boolean> {
  return (await gitProbe(repoRoot, ["cat-file", "-e", objectName])) === 0;
}

async function treeEntryAt(
  repoRoot: string,
  treeish: string,
  sourcePath: string,
): Promise<KnowledgeGitTreeEntry | null> {
  try {
    return await readTreeEntryAtRevision(repoRoot, treeish, sourcePath);
  } catch (error) {
    if (error instanceof GitTreeError && error.code === "GIT_TREE_PARSE") {
      throw new KnowledgeError(
        "KNOWLEDGE_GIT_TREE_FORMAT",
        `Git tree entryを解析できませんでした: ${sourcePath}`,
        { cause: error },
      );
    }
    throw new KnowledgeError(
      "KNOWLEDGE_GIT_TREE_FAILED",
      `Git tree entryを取得できませんでした: ${sourcePath}`,
      { hint: "対象repoのGit状態を確認してください。", cause: error },
    );
  }
}

/** knowledge sourceに許可する通常ファイルのGit tree entryかを返す。 */
export function isRegularKnowledgeSourceEntry(entry: KnowledgeGitTreeEntry): boolean {
  return isRegularGitTreeEntry(entry);
}

async function isAncestorOfHead(repoRoot: string, commit: string): Promise<boolean> {
  const code = await gitProbe(repoRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  if (code === 0) return true;
  if (code === 1) return false;
  throw new KnowledgeError(
    "KNOWLEDGE_GIT_ANCESTOR_FAILED",
    `verification commitがHEADの祖先か判定できませんでした: ${commit}`,
  );
}

async function sourceChangedSince(
  repoRoot: string,
  commit: string,
  sourcePath: string,
): Promise<boolean> {
  const code = await gitProbe(repoRoot, [
    "diff",
    "--quiet",
    "--no-ext-diff",
    commit,
    "--",
    sourcePath,
  ]);
  if (code === 0) return false;
  if (code === 1) return true;
  const detail = `git diff がexit ${code}で終了しました。`;
  throw new KnowledgeError(
    "KNOWLEDGE_GIT_DIFF_FAILED",
    `sourceの鮮度を判定できませんでした: ${sourcePath}（${detail}）`,
  );
}

/** knowledge sourceのGit provenanceを調べる。 */
export async function inspectKnowledgeSourceGit(
  repoRoot: string,
  sourcePath: string,
  verifiedAtCommit: string,
): Promise<KnowledgeSourceGitState> {
  const safeSourcePath = assertSafeRelativePath(sourcePath, "knowledge source path");
  if (!FULL_GIT_OBJECT_ID_RE.test(verifiedAtCommit)) {
    throw new KnowledgeError(
      "KNOWLEDGE_COMMIT_INVALID",
      `verified_at_commitが完全なlowercase Git SHAではありません: ${verifiedAtCommit}`,
    );
  }

  const headExists = await objectExists(repoRoot, "HEAD^{commit}");
  const headEntry = headExists ? await treeEntryAt(repoRoot, "HEAD", safeSourcePath) : null;
  const trackedAtHead = headEntry !== null;
  const commitExists = await objectExists(repoRoot, `${verifiedAtCommit}^{commit}`);
  if (!commitExists) {
    return {
      commitState: "missing",
      headEntry,
      verifiedEntry: null,
      trackedAtHead,
      existsAtVerifiedCommit: null,
      stale: null,
    };
  }

  const verifiedEntry = await treeEntryAt(repoRoot, verifiedAtCommit, safeSourcePath);
  const existsAtVerifiedCommit = verifiedEntry !== null;
  if (!(await isAncestorOfHead(repoRoot, verifiedAtCommit))) {
    return {
      commitState: "not-ancestor",
      headEntry,
      verifiedEntry,
      trackedAtHead,
      existsAtVerifiedCommit,
      stale: null,
    };
  }

  const stale =
    !existsAtVerifiedCommit ||
    !trackedAtHead ||
    (await sourceChangedSince(repoRoot, verifiedAtCommit, safeSourcePath));
  return {
    commitState: "ancestor",
    headEntry,
    verifiedEntry,
    trackedAtHead,
    existsAtVerifiedCommit,
    stale,
  };
}
