import { describe, expect, it } from "vitest";

import { canonicalizeText, canonicalizeTextString } from "../canonical-text.js";

describe("canonicalizeTextString", () => {
  it("CRLF と LF の同一内容は同じ canonical text になる", () => {
    expect(canonicalizeTextString("a\r\nb\r\nc")).toBe("a\nb\nc");
    expect(canonicalizeTextString("a\r\nb\r\nc")).toBe(canonicalizeTextString("a\nb\nc"));
  });

  it("単独 CR を LF に変換する", () => {
    expect(canonicalizeTextString("a\rb\rc")).toBe("a\nb\nc");
  });

  it("CRLF を LFLF に増やさない（CRLF を先に処理する）", () => {
    expect(canonicalizeTextString("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it("先頭 UTF-8 BOM(U+FEFF)を取り除く", () => {
    expect(canonicalizeTextString("﻿hello")).toBe("hello");
  });

  it("途中の U+FEFF は内容として保持する", () => {
    expect(canonicalizeTextString("a﻿b")).toBe("a﻿b");
  });

  it("先頭 BOM のみの差分は同一 canonical text になる", () => {
    expect(canonicalizeTextString("﻿x\r\ny")).toBe(canonicalizeTextString("x\ny"));
  });

  it("空文字はそのまま空文字", () => {
    expect(canonicalizeTextString("")).toBe("");
  });
});

describe("canonicalizeText (Buffer)", () => {
  it("先頭 UTF-8 BOM bytes(EF BB BF)を strip する", () => {
    const withBom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]); // BOM + "hi"
    expect(canonicalizeText(withBom).toString("utf8")).toBe("hi");
  });

  it("CRLF を含む Buffer を LF へ正規化する", () => {
    const crlf = Buffer.from("line1\r\nline2\r\n", "utf8");
    expect(canonicalizeText(crlf).toString("utf8")).toBe("line1\nline2\n");
  });

  it("BOM のみの Buffer は空 Buffer になる", () => {
    const bomOnly = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(canonicalizeText(bomOnly).length).toBe(0);
  });

  it("空 Buffer は空のまま", () => {
    expect(canonicalizeText(Buffer.alloc(0)).length).toBe(0);
  });
});
