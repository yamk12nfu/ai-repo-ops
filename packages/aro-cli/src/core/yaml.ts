/**
 * YAML read/write ユーティリティ。
 *
 * 計画 v3 §7 の技術スタック（`yaml` ライブラリ）に対応する。
 * manifest（読み取り専用）と lock file（読み書き）の双方で使う。
 *
 * 方針:
 *   - parse は安全側に倒し、失敗時は呼び出し側がラップしやすいよう素の例外を投げる。
 *   - stringify は LF 前提（最終的な書き込みは {@link import("./filesystem.js").writeTextFileLf} が
 *     canonical 化して LF・BOM なしに揃えるため、ここでの改行は気にしなくてよい）。
 *   - 出力は決定的にするため key 順を保持し、anchor/alias を使わせない。
 */
import YAML from "yaml";

/**
 * YAML テキストを JS の値へ parse する。
 * 失敗時は `yaml` ライブラリの例外をそのまま投げる（呼び出し側で ManifestError 等にラップする）。
 *
 * @param text   YAML テキスト。
 * @returns parse 結果（`unknown`。スキーマ検証は呼び出し側が zod で行う）。
 */
export function parseYaml(text: string): unknown {
  // prettyErrors で人間が読める位置情報付きのエラーにする。
  return YAML.parse(text, { prettyErrors: true });
}

/**
 * JS の値を YAML テキストへ stringify する。
 *
 * lock file の決定的な出力のため、以下を固定する:
 *   - `lineWidth: 0` で自動折り返しを無効化（行が勝手に折られて diff が荒れるのを防ぐ）。
 *   - `aliasDuplicateObjects: false` で anchor/alias（`&a` / `*a`）を生成させない。
 *
 * key 順は入力オブジェクトのプロパティ順をそのまま使う（`yaml` の既定動作）。
 *
 * @param value stringify 対象の値。
 * @returns YAML テキスト（末尾改行付き）。
 */
export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}
