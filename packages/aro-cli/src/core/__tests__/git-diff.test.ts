import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitDiffError } from "../errors.js";
import { getChangedFiles } from "../git-diff.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import {
  gitCheckout,
  gitCheckoutNewBranch,
  gitCommitAll,
  initRealGitRepo,
} from "../../test-support/git-fixture.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-git-diff-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("getChangedFiles: 通常の numstat parse", () => {
  it("追加/変更行数を numstat から取得する", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "a.txt", "line1\nline2\nline3\n");
    await writeRaw(repoRoot, "b.txt", "new file\n");
    await gitCommitAll(repoRoot, "feat: add lines");

    const entries = await getChangedFiles(repoRoot, "main");
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath["a.txt"]).toEqual({ path: "a.txt", addedLines: 2, deletedLines: 0 });
    expect(byPath["b.txt"]).toEqual({ path: "b.txt", addedLines: 1, deletedLines: 0 });
  });

  it("削除されたファイルも変更として扱う（addedLines=0）", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\nline2\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");
    await rm(path.join(repoRoot, "a.txt"));
    await gitCommitAll(repoRoot, "remove a.txt");

    const entries = await getChangedFiles(repoRoot, "main");
    expect(entries).toEqual([{ path: "a.txt", addedLines: 0, deletedLines: 2 }]);
  });

  it("バイナリファイルは added/deleted ともに null（numstat の '-'）", async () => {
    await writeRaw(repoRoot, "base.txt", "base\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeFile(path.join(repoRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    await gitCommitAll(repoRoot, "add binary");

    const entries = await getChangedFiles(repoRoot, "main");
    expect(entries).toEqual([{ path: "logo.png", addedLines: null, deletedLines: null }]);
  });

  it("変更が無ければ空配列", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");

    const entries = await getChangedFiles(repoRoot, "main");
    expect(entries).toEqual([]);
  });
});

describe("getChangedFiles: merge-base 比較（3 ドット）", () => {
  it("base branch が HEAD 作成後に進んでいても、PR 由来の変更だけを対象にする", async () => {
    await writeRaw(repoRoot, "base.txt", "v1\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "feature.txt", "feature change\n");
    await gitCommitAll(repoRoot, "feat: add feature file");

    // base branch を feature 分岐後に進める（PR 側からは無関係のはずの変更）。
    await gitCheckout(repoRoot, "main");
    await writeRaw(repoRoot, "base.txt", "v2 (main progressed)\n");
    await gitCommitAll(repoRoot, "chore: progress main after branch");

    await gitCheckout(repoRoot, "feature");
    const entries = await getChangedFiles(repoRoot, "main");

    // 2 ドット（git diff main..feature）なら base.txt の差分も混ざるが、
    // 3 ドット（merge-base 比較）なら merge-base（v1 時点）との差分だけになり feature.txt のみ。
    expect(entries.map((e) => e.path)).toEqual(["feature.txt"]);
  });
});

describe("getChangedFiles: エラー", () => {
  it("base ref が解決できなければ GitDiffError（stderr を含む）", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");

    await expect(getChangedFiles(repoRoot, "does-not-exist-ref")).rejects.toBeInstanceOf(GitDiffError);
    await expect(getChangedFiles(repoRoot, "does-not-exist-ref")).rejects.toMatchObject({
      code: "GIT_DIFF_FAILED",
    });
  });
});
