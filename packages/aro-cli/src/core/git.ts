/**
 * 対象 repo の前提条件チェック（計画 v3 §17.1 step 1-2）。
 *
 *   - 対象 path が存在し、ディレクトリであることを確認する。
 *   - その path が Git repo の root であることを確認する。
 *
 * MVP の atomicity / I/O failure rollback（§17.3）は git restore / git clean による復旧を前提にする。
 * そのため init / sync は対象が Git repo であることを必須にする（diff は読み取り専用なので要求しない）。
 *
 * `git` コマンドは実行しない。`.git` エントリの存在だけで判定する:
 *   - 通常の repo:    `.git` ディレクトリ
 *   - worktree など:  `.git` ファイル（`gitdir: ...` を指す）
 * どちらでも root とみなす。`--repo` は「repo の root」を指す前提で、祖先方向の探索はしない
 * （サブディレクトリを渡した場合は「Git repo の root ではない」として扱う。MVP の明示的な制約）。
 */
import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";

import { RepoError } from "./errors.js";

/** Node の errno 例外（`code` を持つ Error）かどうかを判定する。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/** path が存在すれば lstat の結果を返し、存在しなければ null を返す。 */
async function lstatIfExists(absolutePath: string): Promise<Stats | null> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * 対象 repo path を絶対 path に解決し、存在するディレクトリであることを確認する。
 *
 * @param repoPath `--repo` 由来の path（絶対/相対どちらでも可）。
 * @returns 解決済みの絶対 path。
 * @throws {RepoError} path が存在しない（`REPO_NOT_FOUND`）/ ディレクトリでない（`REPO_NOT_DIRECTORY`）場合。
 */
export async function resolveRepoRoot(repoPath: string): Promise<string> {
  const resolved = path.resolve(repoPath);
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new RepoError("REPO_NOT_FOUND", `対象 repo path が存在しません: ${resolved}`, {
        hint: "--repo に既存のディレクトリを指定してください。",
        cause: error,
      });
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new RepoError("REPO_NOT_DIRECTORY", `対象 repo path がディレクトリではありません: ${resolved}`, {
      hint: "--repo にはディレクトリ（Git repo の root）を指定してください。",
    });
  }
  return resolved;
}

/**
 * 対象 repo path を解決し、Git repo の root であることを確認する。
 *
 * `.git` がディレクトリでもファイル（worktree）でも root とみなす。
 *
 * @param repoPath `--repo` 由来の path。
 * @returns 解決済みの絶対 path。
 * @throws {RepoError} path 不正（{@link resolveRepoRoot} 由来）/ Git repo でない（`REPO_NOT_GIT`）場合。
 */
export async function assertGitRepo(repoPath: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(repoPath);
  const gitEntry = await lstatIfExists(path.join(repoRoot, ".git"));
  // `.git` ディレクトリ / ファイル / （万一の）symlink のいずれかが root 直下にあれば Git repo とみなす。
  const isGitRepo =
    gitEntry !== null &&
    (gitEntry.isDirectory() || gitEntry.isFile() || gitEntry.isSymbolicLink());
  if (!isGitRepo) {
    throw new RepoError("REPO_NOT_GIT", `対象 path が Git repo の root ではありません: ${repoRoot}`, {
      hint: "対象 repo の root で `git init` を実行してから再度お試しください。",
    });
  }
  return repoRoot;
}
