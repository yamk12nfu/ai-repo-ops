/**
 * append_unique_lines ユーティリティ。
 *
 * 計画 v3 §9.2 / §16.3 の `append_unique_lines` strategy を実装する。
 * `.gitignore` / `.gitattributes` / `.prettierignore` の3つの patch 先はすべてこの strategy なので、
 * ファイルごとに別実装を持たず、この1関数に集約する（行集合は manifest 側の patch が与える）。
 *
 * 規則（§16.3）:
 *   - 対象ファイルが存在しない: 指定行で新規作成する
 *   - 対象ファイルが存在する:   まだ存在しない行だけ末尾に追記する
 *   - 行比較は LF 正規化後に行単位で行い、既存行の順序・コメントは保持する
 *
 * 既存行と追記行の双方で重複を除去するため、何度適用しても行が重複しない（冪等）。
 */
import { canonicalizeTextString } from "./canonical-text.js";
import { assertNoSymlinkInPath, readFileIfExists, writeTextFileLf } from "./filesystem.js";
import { resolveWithinRoot } from "./paths.js";

/** {@link computeAppendUniqueLines} の結果。 */
export interface AppendUniqueLinesResult {
  /** 適用後のファイル内容（LF・末尾改行付き）。changed が false の場合は既存内容の LF 正規化版。 */
  content: string;
  /** 実際に追記された行（順序保持・重複除去済み）。何も追記しなければ空配列。 */
  addedLines: string[];
  /** 対象ファイルが存在せず新規作成になる場合 true。 */
  created: boolean;
  /** 書き込みが必要（内容が変わる）な場合 true。 */
  changed: boolean;
}

/**
 * 既存内容（無い場合は null）と追記候補行から、append_unique_lines の適用結果を計算する純粋関数。
 *
 * @param existing    既存ファイル内容。ファイルが存在しない場合は null。
 * @param linesToAdd  追記候補行（manifest の patch lines）。
 */
export function computeAppendUniqueLines(
  existing: string | null,
  linesToAdd: readonly string[],
): AppendUniqueLinesResult {
  if (existing === null) {
    // 新規作成: 追記候補内の重複だけ除去し、指定順で書き出す。
    const deduped = dedupePreservingOrder(new Set<string>(), linesToAdd);
    const content = deduped.length > 0 ? `${deduped.join("\n")}\n` : "";
    return {
      content,
      addedLines: deduped,
      created: content.length > 0,
      changed: content.length > 0,
    };
  }

  const normalized = canonicalizeTextString(existing);
  const rawLines = normalized.length === 0 ? [] : normalized.split("\n");
  // 末尾改行由来の空セグメントは「既存行」ではないので除外する。
  // これを残すと既存集合に "" が混入し、空行の追記可否が末尾改行の有無で揺れてしまう。
  const existingLines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines;
  // 既存行に加え、追記候補内の重複も除去する（既存集合を seed にして順次追加）。
  const toAppend = dedupePreservingOrder(new Set(existingLines), linesToAdd);

  if (toAppend.length === 0) {
    // 追記すべき行が無い。既存内容（LF 正規化版）をそのまま返し、書き込みは不要。
    return { content: normalized, addedLines: [], created: false, changed: false };
  }

  // 既存内容と追記行の間に必ず単一の改行を挟む。末尾に改行が無い既存ファイルにも対応する。
  const prefix = normalized.length === 0 || normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  const content = `${prefix}${toAppend.join("\n")}\n`;
  return { content, addedLines: toAppend, created: false, changed: true };
}

/**
 * append_unique_lines を実ファイル（検証済み絶対 path）に適用する低レベル API。
 * 変更が必要なときだけ {@link writeTextFileLf} で LF・BOM なし書き込みを行う。
 * 既存行がすべて揃っている場合は何も書かない（既存の改行コードを温存する）。
 *
 * この関数は path 検証も symlink 検査も行わない。untrusted な相対 path には
 * {@link appendUniqueLinesWithinRoot} を使うこと。
 */
export async function applyAppendUniqueLines(
  absolutePath: string,
  linesToAdd: readonly string[],
): Promise<AppendUniqueLinesResult> {
  const existingBuffer = await readFileIfExists(absolutePath);
  const existing = existingBuffer === null ? null : existingBuffer.toString("utf8");
  const result = computeAppendUniqueLines(existing, linesToAdd);
  if (result.changed) {
    await writeTextFileLf(absolutePath, result.content);
  }
  return result;
}

/**
 * repo root 配下の相対 path へ append_unique_lines を安全に適用する高レベル API。
 *
 * `.gitignore` / `.gitattributes` / `.prettierignore` の patch（manifest 由来の untrusted path）は
 * こちらを使う。読み書き前に {@link resolveWithinRoot} と {@link assertNoSymlinkInPath} を通すため、
 * symlink 経由の repo 外読み書きや path 脱出を防げる（§20.2）。
 */
export async function appendUniqueLinesWithinRoot(
  rootDir: string,
  relativePath: string,
  linesToAdd: readonly string[],
  label = "path",
): Promise<AppendUniqueLinesResult> {
  const absolutePath = resolveWithinRoot(rootDir, relativePath, label);
  await assertNoSymlinkInPath(rootDir, relativePath, label);
  return applyAppendUniqueLines(absolutePath, linesToAdd);
}

/** seen に含まれない行だけを順序保持で抽出し、抽出済みの行も seen に加える。 */
function dedupePreservingOrder(seen: Set<string>, lines: readonly string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}
