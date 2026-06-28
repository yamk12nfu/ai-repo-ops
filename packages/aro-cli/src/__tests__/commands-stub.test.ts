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
    notImplemented("init", "Phase 5");
    expect(process.exitCode).toBe(EXIT_NOT_IMPLEMENTED);
    expect(stderr).toHaveBeenCalledOnce();
  });

  for (const name of ["init", "diff", "sync", "doctor"] as const) {
    it(`aro ${name} は成功(0)ではなく非ゼロで終了する`, async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await run(["node", "aro", name]);
      expect(process.exitCode).toBe(EXIT_NOT_IMPLEMENTED);
    });
  }

  it("diff --detailed-exitcode でも stub は 0(差分なし)を返さない", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(["node", "aro", "diff", "--detailed-exitcode"]);
    expect(process.exitCode).not.toBe(0);
  });
});
