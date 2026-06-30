import { describe, expect, it } from "vitest";

import {
  classifyCreateOnly,
  classifyManagedOverwrite,
  REASON_LOCALLY_MODIFIED,
  REASON_UNTRACKED,
} from "../conflict.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("classifyManagedOverwrite（§16.1）", () => {
  it("target が無ければ create", () => {
    expect(
      classifyManagedOverwrite({ targetSha256: null, installedSha256: null, sourceSha256: A }),
    ).toEqual({ kind: "create" });
  });

  it("target はあるが lock 記録が無ければ conflict（untracked）", () => {
    const result = classifyManagedOverwrite({
      targetSha256: A,
      installedSha256: null,
      sourceSha256: A,
    });
    expect(result.kind).toBe("conflict");
    expect(result.reason).toBe(REASON_UNTRACKED);
  });

  it("target==lock かつ source==lock なら noop", () => {
    expect(
      classifyManagedOverwrite({ targetSha256: A, installedSha256: A, sourceSha256: A }),
    ).toEqual({ kind: "noop" });
  });

  it("target==lock かつ source!=lock なら update（中央だけ更新）", () => {
    expect(
      classifyManagedOverwrite({ targetSha256: A, installedSha256: A, sourceSha256: B }),
    ).toEqual({ kind: "update" });
  });

  it("target!=lock なら conflict（人間が編集）", () => {
    const result = classifyManagedOverwrite({
      targetSha256: C,
      installedSha256: A,
      sourceSha256: B,
    });
    expect(result.kind).toBe("conflict");
    expect(result.reason).toBe(REASON_LOCALLY_MODIFIED);
  });

  it("target!=lock は source==target でも conflict（lock とずれている）", () => {
    // 人間が編集して偶然 source と一致した場合でも lock とは不一致なので安全側に倒す。
    const result = classifyManagedOverwrite({
      targetSha256: B,
      installedSha256: A,
      sourceSha256: B,
    });
    expect(result.kind).toBe("conflict");
  });
});

describe("classifyCreateOnly（§16.2）", () => {
  it("target が無ければ create", () => {
    expect(classifyCreateOnly(false)).toEqual({ kind: "create" });
  });

  it("target があれば preserve", () => {
    expect(classifyCreateOnly(true)).toEqual({ kind: "preserve" });
  });
});
