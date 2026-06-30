import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_NOT_IMPLEMENTED, notImplemented } from "../common-options.js";
import { run } from "../main.js";

describe("未実装 stub コマンドの終了コード", () => {
  const savedExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  it("EXIT_NOT_IMPLEMENTED は成功(0)以外で、計画 §17 の意味づけ済みコード(0-4)とも衝突しない", () => {
    expect(EXIT_NOT_IMPLEMENTED).not.toBe(0);
    expect(EXIT_NOT_IMPLEMENTED).toBeGreaterThan(4);
  });

  it("notImplemented は stderr に通知し非ゼロ終了コードを設定する", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    notImplemented("doctor", "Phase 6");
    expect(process.exitCode).toBe(EXIT_NOT_IMPLEMENTED);
    expect(stderr).toHaveBeenCalledOnce();
  });

  // diff / init / sync は実装済みのため stub 一覧から外す（検証は各 *.test.ts）。doctor のみ Phase 6 で実装予定。
  for (const name of ["doctor"] as const) {
    it(`aro ${name} は成功(0)ではなく非ゼロで終了する`, async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await run(["node", "aro", name]);
      expect(process.exitCode).toBe(EXIT_NOT_IMPLEMENTED);
    });
  }
});
