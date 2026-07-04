/**
 * `git diff --numstat` の実行とパース（`aro guard` の入力取得。計画 03 Stage 1-1）。
 *
 * guard が検証する対象は `<base>...HEAD`（merge-base 比較。3 ドット）の差分。base branch が
 * PR 作成後にさらに進んでいても、比較の起点は `git merge-base <base> HEAD` に固定されるため、
 * PR 由来の変更だけを対象にできる（`<base>..HEAD` の 2 ドット比較は 2 つの木を直接比較するため、
 * base 側の後続コミットまで差分に混ざってしまい、目的に合わない）。
 *
 * `--no-renames` を付けることで rename は「削除 + 追加」の 2 エントリとして扱われる。rename 検出は
 * しきい値次第で結果が変わり得るため、guard の判定（forbidden_paths 等の単純な path 一致）を
 * 曖昧にしないよう明示的に無効化する。
 *
 * `-z` を付けて NUL 区切り出力にする。git は既定（`core.quotePath=true`）で非 ASCII バイトを含む
 * path を `--numstat` の通常出力上 C-style quote + 8 進エスケープする
 * （例: `docs/日本語.md` → `"docs/\346\227\245\346\234\254.md"`）。これを素の tab 区切りとして
 * path 列をそのまま返すと、forbidden_paths / allowed_paths の picomatch 判定がエスケープ済み文字列に
 * 対して行われてしまい、非 ASCII path の判定が壊れる。`-z` はこの quote を無効化し、
 * 生の path バイト列を `\0` 終端で返すため、非 ASCII path も正しく取得できる。
 *
 * core/guard.ts（判定ロジック）とはあえて分離している。guard.ts は git 実行を知らない純粋関数のまま
 * テストでき、git 実行に依存するテスト（実 git repo が必要）はこのモジュールに閉じ込められる。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitDiffError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * `git diff --numstat` 1 行分の変更。
 * バイナリファイルは numstat 上 `-` で表示されるため、addedLines / deletedLines ともに null にする。
 */
export interface GitDiffEntry {
  /** repo root からの相対 path（git 出力そのまま。POSIX 区切り）。 */
  path: string;
  /** 追加行数。バイナリは null。 */
  addedLines: number | null;
  /** 削除行数。バイナリは null。 */
  deletedLines: number | null;
}

/** execFile の失敗（ExecFileException）から stderr 文字列を取り出す。無ければ undefined。 */
function extractStderr(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" ? stderr : undefined;
  }
  return undefined;
}

/**
 * numstat 1 レコードを parse する。`-z` 出力の 1 レコードは `<added>\t<deleted>\t<path>`
 * （tab 区切り、`\0` 終端。`--no-renames` 指定済みのため rename 特殊形式・2 個目の NUL 終端 path は出ない）。
 * path 自体に tab を含むことは実運用上ありえないが、3 列目以降を join して保守的に扱う。
 */
function parseNumstatRecord(record: string): GitDiffEntry {
  const [addedRaw, deletedRaw, ...pathParts] = record.split("\t");
  const path = pathParts.join("\t");
  if (addedRaw === undefined || deletedRaw === undefined || path.length === 0) {
    throw new GitDiffError(
      "GIT_DIFF_PARSE",
      `git diff --numstat -z の出力レコードを解釈できません: ${JSON.stringify(record)}`,
    );
  }
  return {
    path,
    addedLines: addedRaw === "-" ? null : Number(addedRaw),
    deletedLines: deletedRaw === "-" ? null : Number(deletedRaw),
  };
}

/** `-z` 出力全体を `\0` で分割して parse する（末尾の空レコードは無視）。 */
function parseNumstat(stdout: string): GitDiffEntry[] {
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => parseNumstatRecord(record));
}

/**
 * `<base>...HEAD`（merge-base 比較）の変更ファイル一覧を numstat で取得する。読み取り専用。
 *
 * @param repoRoot 対象 repo の root（絶対 path 推奨。Git repo であること）。
 * @param base     比較対象の base ref（ブランチ名・タグ・commit SHA 等）。
 * @throws {GitDiffError} git コマンドが異常終了した場合（base ref が存在しない等、code: `GIT_DIFF_FAILED`）、
 *   または numstat 出力を解釈できない場合（code: `GIT_DIFF_PARSE`）。
 */
export async function getChangedFiles(repoRoot: string, base: string): Promise<GitDiffEntry[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", repoRoot, "diff", "--numstat", "-z", "--no-renames", `${base}...HEAD`],
      { encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (error) {
    const stderr = extractStderr(error);
    const detail = stderr !== undefined && stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";
    throw new GitDiffError(
      "GIT_DIFF_FAILED",
      `git diff の実行に失敗しました（${base}...HEAD）。${detail}`,
      {
        hint: "--base に指定した ref が対象 repo に存在するか確認してください（fetch 不足の可能性もあります）。",
        cause: error,
      },
    );
  }
  return parseNumstat(stdout);
}
