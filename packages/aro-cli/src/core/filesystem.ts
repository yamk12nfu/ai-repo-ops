/**
 * ファイルシステムユーティリティ。
 *
 * 計画 v3 §6.4「aro が書き込むときは LF」、§20.2「symlink は追従しない」、
 * §23.3「ファイル変更前に必ず親ディレクトリを作成する」に対応する。
 *
 * 書き込みは UTF-8 / LF / BOM なしに統一する（{@link writeTextFileLf}）。
 * symlink 検査（{@link assertNoSymlinkInPath}）は FS アクセスが必要なため paths.ts ではなくここに置く。
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalizeTextString } from "./canonical-text.js";
import { canonicalSha256 } from "./checksum.js";
import { PathSafetyError } from "./errors.js";
import { assertSafeRelativePath, resolveWithinRoot } from "./paths.js";

/** Node の errno 例外（`code` を持つ Error）かどうかを判定する。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * ファイルを読む。存在しない（ENOENT）場合は null を返す。
 * conflict 判定・append 処理で「未作成」と「読めない」を区別するために使う。
 */
export async function readFileIfExists(absolutePath: string): Promise<Buffer | null> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** 親も含めてディレクトリを作成する（既存なら何もしない）。 */
export async function ensureDir(absoluteDir: string): Promise<void> {
  await mkdir(absoluteDir, { recursive: true });
}

/**
 * テキストファイルを UTF-8 / LF / BOM なしで書き込む。
 *
 * 入力文字列は {@link canonicalizeTextString} で正規化してから書くため、
 * 呼び出し側が CRLF や先頭 BOM を渡しても、ディスク上は必ず LF・BOM なしになる。
 * 親ディレクトリが無ければ作成する。
 *
 * 注意（§20.2 の契約）: この関数自身は symlink を検査しない。`writeFile`（既定 flag 'w'）も
 * `mkdir` も symlink を追従するため、repo 外への書き込みを防ぐには呼び出し側（Phase 5 の apply 層）が
 * 書き込み前に {@link assertNoSymlinkInPath} を通すこと。検査と書き込みは別 syscall のため TOCTOU 窓は残る。
 */
export async function writeTextFileLf(absolutePath: string, content: string): Promise<void> {
  const normalized = canonicalizeTextString(content);
  await ensureDir(path.dirname(absolutePath));
  await writeFile(absolutePath, Buffer.from(normalized, "utf8"));
}

/**
 * repo root 配下の相対 path へ安全にテキストを書き込む高レベル API。
 *
 * untrusted な相対 path（manifest の dest など）はこちらを使う。書き込み前に必ず
 * {@link resolveWithinRoot}（traversal / 絶対 path / 予約名 / 別名拒否）と
 * {@link assertNoSymlinkInPath}（symlink 非追従、§20.2）を通すため、
 * symlink 経由の repo 外書き込みや path 脱出を防げる。
 * 解決後の絶対 path を返す。
 *
 * 低レベルの {@link writeTextFileLf} は path 検証を行わないので、検証済み path にだけ使うこと。
 */
export async function writeTextFileWithinRoot(
  rootDir: string,
  relativePath: string,
  content: string,
  label = "path",
): Promise<string> {
  const absolutePath = resolveWithinRoot(rootDir, relativePath, label);
  await assertNoSymlinkInPath(rootDir, relativePath, label);
  await writeTextFileLf(absolutePath, content);
  return absolutePath;
}

/**
 * ファイルの canonical SHA-256 を返す。存在しなければ null。
 * {@link readFileIfExists} と {@link canonicalSha256} の合成で、conflict 判定の入力に使う。
 */
export async function canonicalSha256OfFile(absolutePath: string): Promise<string | null> {
  const buffer = await readFileIfExists(absolutePath);
  return buffer === null ? null : canonicalSha256(buffer);
}

/**
 * root からの相対 path の各構成要素に symlink が無いことを検証する。
 *
 * MVP では symlink を一切追従しない（計画 §20.2「対象 path または親 path に symlink がある場合は error」）。
 * root 自身やその祖先（例: macOS の `/tmp` -> `/private/tmp`、`/var` -> `/private/var`）は
 * 検査対象に含めない（root は aro の起動コンテキストが定める信頼境界とみなす）。
 * root 内に新規作成する相対 path の各要素だけを、浅い側から順に lstat する。
 * 途中で ENOENT になった時点（=まだ存在しない）で打ち切る。
 *
 * これは check-then-write であり、検査通過後・書き込み前に対象を symlink へ差し替えられる
 * TOCTOU 窓が残る（MVP の既知の限界。ローカル単一プロセス前提）。O_NOFOLLOW 相当は使わない。
 *
 * @param rootDir      基準ディレクトリ。
 * @param relativePath root からの相対 path。
 * @param label        エラーメッセージ用ラベル。
 */
export async function assertNoSymlinkInPath(
  rootDir: string,
  relativePath: string,
  label = "path",
): Promise<void> {
  const safeRelative = assertSafeRelativePath(relativePath, label);
  const rootResolved = path.resolve(rootDir);

  let current = rootResolved;
  for (const segment of safeRelative.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      // この要素から先はまだ存在しない。存在しない場所に symlink は無いので打ち切る。
      if (isErrnoException(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new PathSafetyError(
        "PATH_SYMLINK",
        `${label} の構成要素が symlink です: ${path.relative(rootResolved, current)}`,
        relativePath,
        { hint: "MVP では symlink を追従しません。実ファイル/ディレクトリに置き換えてください。" },
      );
    }
  }
}
