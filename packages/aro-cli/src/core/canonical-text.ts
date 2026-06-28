/**
 * テキスト正規化（canonical text）ユーティリティ。
 *
 * 計画 v3 §6.2 の checksum mode `canonical_text_lf_utf8bom_strip_v1` に対応する。
 * checksum 計算・ファイル書き込みの双方でこの正規化を共有することで、
 * 改行コード（CRLF/CR/LF）や先頭 BOM の違いだけで差分・conflict が出ないようにする。
 *
 * 正規化規則:
 *   1. UTF-8 として decode する
 *   2. 先頭が U+FEFF（BOM）のときだけ取り除く（途中の U+FEFF は内容として保持）
 *   3. CRLF を LF へ変換する
 *   4. 単独 CR を LF へ変換する
 */

/**
 * 文字列を canonical text へ正規化する。
 * 先頭 UTF-8 BOM を strip し、CRLF / 単独 CR を LF に揃える。
 */
export function canonicalizeTextString(input: string): string {
  // 先頭 U+FEFF のみ除去する。slice(1) は他の文字に影響しない。
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // CRLF を先に潰してから単独 CR を処理する（順序を逆にすると CRLF が LFLF にならないよう注意）。
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Buffer を canonical text の UTF-8 bytes に変換する。
 * checksum 計算の入力に使う。先頭 UTF-8 BOM bytes（EF BB BF）は decode 後に U+FEFF となり strip される。
 */
export function canonicalizeText(input: Buffer): Buffer {
  return Buffer.from(canonicalizeTextString(input.toString("utf8")), "utf8");
}
