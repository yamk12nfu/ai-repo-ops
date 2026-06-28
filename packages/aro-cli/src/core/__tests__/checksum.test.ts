import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CHECKSUM_ALGORITHM,
  CHECKSUM_MODE,
  canonicalSha256,
  canonicalSha256OfString,
  sha256Hex,
} from "../checksum.js";

const sha256OfUtf8 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("checksum 定数", () => {
  it("mode 名と algorithm は計画 §6.2 の固定値", () => {
    expect(CHECKSUM_MODE).toBe("canonical_text_lf_utf8bom_strip_v1");
    expect(CHECKSUM_ALGORITHM).toBe("sha256");
  });
});

describe("sha256Hex", () => {
  it("小文字 hex 64 文字を返す", () => {
    const hex = sha256Hex("hello");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("既知の入力に対する SHA-256 と一致する（canonical 化なしの生 hash）", () => {
    expect(sha256Hex("a\r\nb")).toBe(sha256OfUtf8("a\r\nb"));
  });
});

describe("canonicalSha256", () => {
  it("CRLF と LF の同一内容は同じ checksum になる", () => {
    expect(canonicalSha256(Buffer.from("a\r\nb\r\nc", "utf8"))).toBe(
      canonicalSha256(Buffer.from("a\nb\nc", "utf8")),
    );
  });

  it("単独 CR と LF の同一内容も同じ checksum になる", () => {
    expect(canonicalSha256(Buffer.from("a\rb", "utf8"))).toBe(
      canonicalSha256(Buffer.from("a\nb", "utf8")),
    );
  });

  it("先頭 UTF-8 BOM の有無だけでは checksum が変わらない", () => {
    const withBom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("x\ny", "utf8")]);
    const withoutBom = Buffer.from("x\ny", "utf8");
    expect(canonicalSha256(withBom)).toBe(canonicalSha256(withoutBom));
  });

  it("実内容の変更は checksum 差分になる", () => {
    expect(canonicalSha256(Buffer.from("hello\n", "utf8"))).not.toBe(
      canonicalSha256(Buffer.from("hello!\n", "utf8")),
    );
  });

  it("canonical 化後の bytes に対する SHA-256 と一致する", () => {
    // "a\r\nb" は canonical 化で "a\nb" になる。
    expect(canonicalSha256(Buffer.from("a\r\nb", "utf8"))).toBe(sha256OfUtf8("a\nb"));
  });
});

describe("canonicalSha256OfString", () => {
  it("文字列版と Buffer 版は同じ結果になる", () => {
    expect(canonicalSha256OfString("a\r\nb")).toBe(canonicalSha256(Buffer.from("a\r\nb", "utf8")));
  });
});
