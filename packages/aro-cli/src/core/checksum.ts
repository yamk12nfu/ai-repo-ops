/**
 * checksum ユーティリティ。
 *
 * 計画 v3 §6 のとおり、テキストは canonical 化してから SHA-256 を計算する。
 * これにより CRLF/CR/LF・先頭 BOM の違いだけでは checksum が変わらず、
 * 実内容の変更だけが checksum 差分として現れる。
 */
import { createHash } from "node:crypto";

import { canonicalizeText, canonicalizeTextString } from "./canonical-text.js";

/** checksum アルゴリズム。lock file の `checksum.algorithm` に記録する。 */
export const CHECKSUM_ALGORITHM = "sha256" as const;

/**
 * checksum mode 名。lock file の `checksum.mode` に記録する。
 * 計画 §6.2 / §7「canonical_text_lf_utf8bom_strip_v1」。
 */
export const CHECKSUM_MODE = "canonical_text_lf_utf8bom_strip_v1" as const;

/** 任意の bytes / 文字列の SHA-256 を小文字 hex で返す（canonical 化はしない生 hash）。 */
export function sha256Hex(data: Buffer | string): string {
  return createHash(CHECKSUM_ALGORITHM).update(data).digest("hex");
}

/**
 * Buffer を canonical text 化してから SHA-256 を計算する。
 * 配布ファイル・対象 repo の managed file・lock の installed_sha256 すべてでこの関数を使う。
 */
export function canonicalSha256(input: Buffer): string {
  return sha256Hex(canonicalizeText(input));
}

/** メモリ上の文字列を canonical text 化してから SHA-256 を計算する。 */
export function canonicalSha256OfString(input: string): string {
  return sha256Hex(Buffer.from(canonicalizeTextString(input), "utf8"));
}
