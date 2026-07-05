/**
 * `aro guard` テスト用の実 git repo フィクスチャ（`.fixture.ts` はビルド対象外）。
 *
 * distribution.fixture.ts の {@link import("./distribution.fixture.js").initGitRepo} は
 * `.git` ディレクトリを mkdir するだけの偽装で、`assertGitRepo` の前提条件チェックにしか使えない。
 * core/git-diff.ts（実際に `git diff --numstat` を実行する）と core/__tests__/git-diff.test.ts /
 * commands/__tests__/guard.test.ts のテストには実 git repo が必要なため、ここでは最小限の
 * git 操作（init・commit・branch 切替）を提供する。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** repoRoot を cwd として git コマンドを実行し、stdout を返す。 */
async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.stdout;
}

/**
 * 実 git repo を初期化し、決定的に commit できるよう user.email/name とローカル設定を行う。
 *
 * `commit.gpgsign` はテスト環境のグローバル設定に関わらず無効化する（署名鍵未設定の CI/sandbox で
 * commit が失敗するのを防ぐ、このフィクスチャ専用の一時 repo に対する設定）。
 */
export async function initRealGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoRoot });
  await git(repoRoot, ["config", "user.email", "aro-guard-test@example.com"]);
  await git(repoRoot, ["config", "user.name", "aro guard test"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
}

/** working tree の変更をすべて `git add -A` してから commit する。 */
export async function gitCommitAll(repoRoot: string, message: string): Promise<void> {
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "--no-verify", "-m", message]);
}

/** 現在の HEAD から新しい branch を作って checkout する。 */
export async function gitCheckoutNewBranch(repoRoot: string, branch: string): Promise<void> {
  await git(repoRoot, ["checkout", "-b", branch]);
}

/** 既存の ref（branch 名等）を checkout する。 */
export async function gitCheckout(repoRoot: string, ref: string): Promise<void> {
  await git(repoRoot, ["checkout", ref]);
}

/** ref（branch 名・HEAD 等）を commit SHA へ解決する。テストで「期待する merge-base」を求めるのに使う。 */
export async function gitRevParse(repoRoot: string, ref: string): Promise<string> {
  return (await git(repoRoot, ["rev-parse", ref])).trim();
}
