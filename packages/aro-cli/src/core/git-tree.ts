/** Git tree entry / blobを安全に読み取る共通helper。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitTreeError } from "./errors.js";
import { assertSafeRelativePath } from "./paths.js";

const execFileAsync = promisify(execFile);

/** 大規模treeと大きめのblobを扱えるよう、git出力を最大64MBまで受け取る。 */
const GIT_TREE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** SHA-1またはSHA-256 repositoryの完全長lowercase object ID。 */
export const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** 指定revisionのGit tree entry。 */
export interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
}

/** 通常fileとして扱えるblob entryかを返す。 */
export function isRegularGitTreeEntry(entry: GitTreeEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

function extractStderr(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" ? stderr : undefined;
  }
  return undefined;
}

function parseTreeEntry(
  stdout: string,
  revision: string,
  expectedPath: string,
): GitTreeEntry | null {
  const record = stdout.endsWith("\0") ? stdout.slice(0, -1) : stdout;
  if (record.length === 0) return null;
  if (record.includes("\0")) {
    throw new GitTreeError(
      "GIT_TREE_PARSE",
      `git ls-tree が複数entryを返しました: ${revision}:${expectedPath}`,
    );
  }

  const match = /^(\d{6}) ([^ ]+) ([^ ]+)\t([\s\S]+)$/u.exec(record);
  if (
    match === null ||
    !FULL_GIT_OBJECT_ID_RE.test(match[3] ?? "") ||
    match[4] !== expectedPath
  ) {
    throw new GitTreeError(
      "GIT_TREE_PARSE",
      `git ls-tree の出力を解釈できません: ${revision}:${expectedPath}`,
    );
  }
  return {
    mode: match[1] ?? "",
    type: match[2] ?? "",
    objectId: match[3] ?? "",
  };
}

/** 指定revision/pathのtree entryをliteral pathspecで読む。存在しなければnull。 */
export async function readTreeEntryAtRevision(
  repoRoot: string,
  revision: string,
  filePath: string,
): Promise<GitTreeEntry | null> {
  const safePath = assertSafeRelativePath(filePath, "git tree path");
  try {
    const result = await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-tree",
        "-z",
        "--full-tree",
        revision,
        "--",
        `:(literal)${safePath}`,
      ],
      { encoding: "utf8", maxBuffer: GIT_TREE_MAX_BUFFER_BYTES },
    );
    return parseTreeEntry(result.stdout, revision, safePath);
  } catch (error) {
    if (error instanceof GitTreeError) throw error;
    const stderr = extractStderr(error);
    const detail = stderr !== undefined && stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";
    throw new GitTreeError(
      "GIT_TREE_FAILED",
      `git ls-tree ${revision}:${safePath} の実行に失敗しました。${detail}`,
      { cause: error },
    );
  }
}

/** 完全長object IDが指すblobの生bytesを読む。 */
export async function readBlobObject(repoRoot: string, objectId: string): Promise<Buffer> {
  if (!FULL_GIT_OBJECT_ID_RE.test(objectId)) {
    throw new GitTreeError("GIT_BLOB_ID_INVALID", `Git object idが不正です: ${objectId}`);
  }
  try {
    const result = await execFileAsync("git", ["-C", repoRoot, "cat-file", "blob", objectId], {
      encoding: null,
      maxBuffer: GIT_TREE_MAX_BUFFER_BYTES,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    const stderr = extractStderr(error);
    const detail = stderr !== undefined && stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";
    throw new GitTreeError(
      "GIT_BLOB_FAILED",
      `git cat-file blob の実行に失敗しました。${detail}`,
      { cause: error },
    );
  }
}
