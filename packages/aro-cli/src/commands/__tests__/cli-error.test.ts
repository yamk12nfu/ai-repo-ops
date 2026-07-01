import { describe, expect, it } from "vitest";

import { ApplyIoError } from "../../core/apply.js";
import { AroError } from "../../core/errors.js";
import { errorToJson, formatApplyIoError, formatAroError } from "../cli-error.js";

describe("formatApplyIoError: §17.3 復旧導線", () => {
  it("既存ファイルは git restore、新規ファイルは rm -f に分けて案内する", () => {
    const error = new ApplyIoError(
      ".github/work flow.md",
      [".ai/managed/y.md", ".ai/managed/x.md", ".github/work flow.md"],
      [".ai/managed/x.md", ".github/work flow.md"],
      new Error("EACCES: permission denied"),
    );
    const text = formatApplyIoError(error);

    // 既存（modified）= y.md のみが git restore 対象。新規は含めない（さもないと git が全体 abort する）。
    expect(text).toContain("git restore -- '.ai/managed/y.md'");
    expect(text).not.toMatch(/git restore[^\n]*x\.md/);
    expect(text).not.toMatch(/git restore[^\n]*work flow/);

    // 新規（created）= x.md と spaced path が rm -f 対象。
    expect(text).toContain("rm -f '.ai/managed/x.md' '.github/work flow.md'");

    // 空白を含む path は single-quote で囲まれ、コマンドが壊れない。
    expect(text).toContain("'.github/work flow.md'");

    // Touched paths 一覧と原因も出る。
    expect(text).toContain("Touched paths");
    expect(text).toContain("EACCES");
  });

  it("復旧対象が無ければその旨を表示する（touched が空）", () => {
    const error = new ApplyIoError("x", [], [], new Error("boom"));
    const text = formatApplyIoError(error);
    expect(text).toContain("復旧対象");
    expect(text).not.toContain("git restore");
    expect(text).not.toContain("rm -f");
  });
});

describe("errorToJson", () => {
  it("ApplyIoError は touchedPaths / newPaths を含む", () => {
    const error = new ApplyIoError("x", ["a", "b"], ["b"], new Error("boom"));
    const json = errorToJson(error);
    expect(json.code).toBe("APPLY_IO_FAILED");
    expect(json.touchedPaths).toEqual(["a", "b"]);
    expect(json.newPaths).toEqual(["b"]);
  });

  it("AroError は code / message / hint を含む", () => {
    const error = new AroError("SOME_CODE", "壊れています", { hint: "直してください" });
    const json = errorToJson(error);
    expect(json).toEqual({ code: "SOME_CODE", message: "壊れています", hint: "直してください" });
  });

  it("非 AroError は UNEXPECTED にフォールバックする", () => {
    expect(errorToJson(new Error("plain")).code).toBe("UNEXPECTED");
    expect(errorToJson("string error").message).toBe("string error");
  });
});

describe("formatAroError", () => {
  it("AroError は hint を添える", () => {
    const text = formatAroError(new AroError("C", "msg", { hint: "ヒント" }));
    expect(text).toContain("ERROR msg");
    expect(text).toContain("ヒント");
  });

  it("非 Error は文字列化する", () => {
    expect(formatAroError("oops")).toBe("ERROR oops");
  });
});
