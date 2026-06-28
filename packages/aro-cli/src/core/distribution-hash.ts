/**
 * distribution content hash（`distribution_content_sha256`）の計算。
 *
 * 計画 v3 §10 のとおり、実装者によって hash が揺れないよう正規シリアライズ仕様を固定する。
 * この hash は「対象 repo に影響する配布 payload」が変わったかを判定するためのもので、
 * `manifest.version` やコメント・YAML key 順・エントリ順・src の path 文字列には依存させない。
 *
 * 正規化ルール（§10.4）:
 *   1. managed_files は dest 昇順で sort
 *   2. seed_files は dest 昇順で sort
 *   3. patches は (type, path, JSON.stringify(lines)) の昇順で sort
 *   4. object key は再帰的に UTF-16 code unit 昇順で sort（{@link stableJson}）
 *   5. JSON は余分な空白なしで stringify
 *   6. UTF-8 bytes 化
 *   7. SHA-256 hex lowercase
 *
 * `append_unique_lines.lines` の行順は適用結果（追記順）に影響するため sort しない（§10.4 末尾）。
 */
import { CHECKSUM_MODE, sha256Hex } from "./checksum.js";

/**
 * distribution content hash の対象となる正規 payload（§10.3）。
 * ここに含めるフィールドだけが hash に影響する。`manifest.version` は意図的に含めない。
 */
export interface DistributionHashPayload {
  /** manifest schema version。 */
  schema_version: number;
  /** distribution 名。 */
  distribution: string;
  /** checksum mode（canonical_text_lf_utf8bom_strip_v1）。 */
  checksum_mode: typeof CHECKSUM_MODE;
  /** managed file（managed_overwrite）の配布内容。dest 昇順。 */
  managed_files: Array<{
    dest: string;
    strategy: "managed_overwrite";
    sha256: string;
  }>;
  /** seed file（create_only）の配布内容。dest 昇順。create_only でも内容変化は payload 変化として扱う（§10.6）。 */
  seed_files: Array<{
    dest: string;
    strategy: "create_only";
    source_kind: "src" | "template";
    sha256: string;
  }>;
  /** patch（append_unique_lines）の配布内容。(type, path, lines) で sort。lines 内は順序保持。 */
  patches: Array<{
    type: "append_unique_lines";
    path: string;
    lines: string[];
  }>;
}

/** {@link buildDistributionHashPayload} への入力（sort 前の生エントリ）。 */
export interface DistributionHashInput {
  schema_version: number;
  distribution: string;
  managed_files: ReadonlyArray<{ dest: string; sha256: string }>;
  seed_files: ReadonlyArray<{ dest: string; source_kind: "src" | "template"; sha256: string }>;
  patches: ReadonlyArray<{ path: string; lines: readonly string[] }>;
}

/** 文字列を UTF-16 code unit 昇順で比較する（JS の既定文字列比較）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 生の配布エントリから、配列を §10.4 のルールで sort した正規 payload を構築する。
 * object key の sort と stringify は {@link stableJson} 側で行うため、ここでは配列順だけを正規化する。
 */
export function buildDistributionHashPayload(input: DistributionHashInput): DistributionHashPayload {
  const managed_files = input.managed_files
    .map((m) => ({ dest: m.dest, strategy: "managed_overwrite" as const, sha256: m.sha256 }))
    .sort((a, b) => compareStrings(a.dest, b.dest));

  const seed_files = input.seed_files
    .map((s) => ({
      dest: s.dest,
      strategy: "create_only" as const,
      source_kind: s.source_kind,
      sha256: s.sha256,
    }))
    .sort((a, b) => compareStrings(a.dest, b.dest));

  const patches = input.patches
    .map((p) => ({ type: "append_unique_lines" as const, path: p.path, lines: [...p.lines] }))
    .sort((a, b) => {
      const byType = compareStrings(a.type, b.type);
      if (byType !== 0) return byType;
      const byPath = compareStrings(a.path, b.path);
      if (byPath !== 0) return byPath;
      // lines の中身は sort しないが、patch エントリ間の決定的順序付けには内容比較が要る。
      return compareStrings(JSON.stringify(a.lines), JSON.stringify(b.lines));
    });

  return {
    schema_version: input.schema_version,
    distribution: input.distribution,
    checksum_mode: CHECKSUM_MODE,
    managed_files,
    seed_files,
    patches,
  };
}

/**
 * 値を決定的な JSON 文字列へシリアライズする（§10.4 / §10.5 の疑似コードに対応）。
 *
 * - object key を再帰的に UTF-16 code unit 昇順で sort する。
 * - 配列の順序は保持する（呼び出し前に {@link buildDistributionHashPayload} で正規化済み前提）。
 * - 余分な空白を入れない（`JSON.stringify` の既定 separator）。
 *
 * `undefined` は通常の payload には現れない想定。混入した場合は `JSON.stringify(undefined)` が
 * `undefined`（非 JSON）を返すため、payload には optional フィールドを残さないこと。
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      compareStrings(a, b),
    );
    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 正規 payload から distribution content sha256（hex lowercase）を計算する。
 * {@link buildDistributionHashPayload} で配列を正規化した payload を渡すこと。
 */
export function computeDistributionContentSha256(payload: DistributionHashPayload): string {
  return sha256Hex(Buffer.from(stableJson(payload), "utf8"));
}
