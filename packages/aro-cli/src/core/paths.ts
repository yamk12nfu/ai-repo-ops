/**
 * path safety ユーティリティ（純粋関数。FS には触れない）。
 *
 * 計画 v3 §20.1 のとおり、manifest の `src` / `dest` / patch path は必ずここを通す。
 * 絶対 path・`..` traversal・Windows ドライブ/UNC・NUL 文字を拒否し、
 * OS 非依存（Windows 区切り `\` も区切りとして扱う）に検証する。
 *
 * symlink 検査だけは FS アクセスが必要なため filesystem.ts 側に置く。
 */
import path from "node:path";

import { PathSafetyError } from "./errors.js";

/** 相対 path 違反時に共通で添える復旧ヒント。 */
const RELATIVE_PATH_HINT =
  "repo root からの相対 path（例: .ai/managed/prompts/review.md）を指定してください。";

/**
 * 安全な相対 path かどうかを検証し、POSIX 区切りに正規化した相対 path を返す。
 *
 * 受理:  `.ai/managed/x.md`, `./a/b`（→ `a/b`）, `a\\b`（→ `a/b`）
 * 拒否:  空文字, `/abs`, `C:\\x`, `\\\\host\\share`, `a/../b`, `..`, `".. "`（末尾空白付き `..`）,
 *        `file.`/`file `（末尾ドット/空白）, `file.txt:stream`（NTFS ADS）,
 *        `NUL`/`CON` 等の予約デバイス名, NUL 文字を含む path
 *
 * @param rawPath 検証対象の相対 path 文字列。
 * @param label   エラーメッセージ用のラベル（例: "src", "dest"）。
 * @returns POSIX 区切りに正規化した相対 path（先頭 `./` や冗長な区切りを除去済み）。
 */
export function assertSafeRelativePath(rawPath: string, label = "path"): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new PathSafetyError(
      "PATH_EMPTY",
      `${label} が空です。`,
      typeof rawPath === "string" ? rawPath : String(rawPath),
      { hint: RELATIVE_PATH_HINT },
    );
  }
  if (rawPath.includes("\0")) {
    throw new PathSafetyError(
      "PATH_NUL",
      `${label} に NUL 文字が含まれています: ${JSON.stringify(rawPath)}`,
      rawPath,
    );
  }

  // Windows 由来の `\` も区切りとして扱い、traversal 検査を OS 非依存にする。
  const unified = rawPath.replace(/\\/g, "/");

  if (unified.startsWith("/")) {
    throw new PathSafetyError(
      "PATH_ABSOLUTE",
      `${label} に絶対 path は使えません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  // 空セグメント（連続スラッシュ・末尾スラッシュ）と `.` を除去して実体だけにする。
  // ドライブ付き path（C:\ / C:rel）はセグメント単位で拒否するため、ここでの top-level 判定は不要。
  const segments = unified.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new PathSafetyError(
      "PATH_EMPTY",
      `${label} が実体のある相対 path になっていません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  for (const segment of segments) {
    assertSafeSegment(segment, rawPath, label);
  }

  return segments.join("/");
}

/**
 * 1 セグメント分の安全性を Windows セマンティクスに合わせて検証する。
 *
 * - `..` および末尾に `.`/空白だけが付いた `..`（Win32 はファイル名末尾の `.`/空白を strip するため
 *   `".. "` がカーネルで `..` に化ける）を含む「ドットと空白のみ」のセグメントを traversal として拒否する。
 *   これを弾かないと、文字列・lexical 検査を素通りした `".. "` が Windows で親ディレクトリへ脱出しうる。
 * - 末尾が `.` または空白のセグメント（`file.` / `file ` / `name. `）を拒否する。Win32 はこれらを
 *   strip して `file` / `name` に化けさせるため、dest 文字列と実ファイルの 1:1 対応が崩れ、
 *   conflict/checksum 判定の前提（dest ごとに固有のファイル）が破れる。
 * - `C:\` / `C:rel` などドライブ付きは絶対 path として拒否する。
 * - セグメント内のコロンは NTFS 代替データストリーム（`file.txt:stream`）等の危険指定として拒否する。
 * - `CON`/`PRN`/`AUX`/`NUL`/`COM1`-`9`/`LPT1`-`9`（拡張子の有無を問わず）は予約デバイス名として拒否する。
 *
 * MVP の配布先（`.ai/...`, `.github/...`）はこれらに該当しないため、過剰拒否の実害は無く、
 * Windows 上での traversal / 別名 / device 書き込みを未然に防ぐ defense in depth として安全側に倒す。
 */
function assertSafeSegment(segment: string, rawPath: string, label: string): void {
  if (/^[ .]+$/u.test(segment)) {
    throw new PathSafetyError(
      "PATH_TRAVERSAL",
      `${label} に親ディレクトリ参照(..)やドット/空白のみのセグメントは使えません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  // 末尾が `.` または空白のセグメントは Win32 が strip して別名になる（`file.`/`file ` -> `file`）。
  if (/[ .]$/u.test(segment)) {
    throw new PathSafetyError(
      "PATH_RESERVED",
      `${label} に末尾が「.」または空白のセグメントは使えません（Windows で別名になります）: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  if (/^[A-Za-z]:/u.test(segment)) {
    throw new PathSafetyError(
      "PATH_ABSOLUTE",
      `${label} に Windows ドライブ付き path は使えません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  if (segment.includes(":")) {
    throw new PathSafetyError(
      "PATH_RESERVED",
      `${label} にコロン(:)を含むセグメント（NTFS 代替データストリーム等）は使えません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
  const deviceBase = segment.split(".")[0] ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(deviceBase)) {
    throw new PathSafetyError(
      "PATH_RESERVED",
      `${label} に Windows 予約デバイス名は使えません: ${rawPath}`,
      rawPath,
      { hint: RELATIVE_PATH_HINT },
    );
  }
}

/**
 * repo root（または source root）配下の絶対 path を安全に解決する。
 *
 * {@link assertSafeRelativePath} で文字列レベルの traversal を弾いたうえで、
 * 解決後の絶対 path が root の内側に収まることを再確認する（defense in depth）。
 *
 * @param rootDir      基準ディレクトリ（絶対/相対どちらでも可。内部で resolve する）。
 * @param relativePath root からの相対 path。
 * @param label        エラーメッセージ用のラベル。
 * @returns root 配下に収まる絶対 path。
 */
export function resolveWithinRoot(rootDir: string, relativePath: string, label = "path"): string {
  const safeRelative = assertSafeRelativePath(relativePath, label);
  const rootResolved = path.resolve(rootDir);
  const resolved = path.resolve(rootResolved, safeRelative);

  const relativeFromRoot = path.relative(rootResolved, resolved);
  const escapesRoot =
    relativeFromRoot.length === 0 ||
    relativeFromRoot === ".." ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot);
  if (escapesRoot) {
    throw new PathSafetyError(
      "PATH_ESCAPE",
      `${label} が基準ディレクトリの外を指しています: ${relativePath}`,
      relativePath,
      { hint: RELATIVE_PATH_HINT },
    );
  }

  return resolved;
}
