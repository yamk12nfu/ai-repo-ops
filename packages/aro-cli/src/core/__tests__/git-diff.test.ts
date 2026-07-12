import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitDiffError } from "../errors.js";
import {
  isRegularGitTreeEntry,
  readBlobObject,
  readTreeEntryAtRevision,
} from "../git-tree.js";
import {
  getChangedFiles,
  getMergeBase,
  readFileAtRevision,
} from "../git-diff.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import {
  gitCheckout,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitRevParse,
  initRealGitRepo,
} from "../../test-support/git.fixture.js";

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

  it("非 ASCII path は core.quotePath による C-style quote を受けず生の path で取得できる（-z）", async () => {
    await writeRaw(repoRoot, "base.txt", "base\n");
    await gitCommitAll(repoRoot, "init");
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "docs/日本語.md", "こんにちは\n");
    await gitCommitAll(repoRoot, "docs: 日本語ファイルを追加");

    const entries = await getChangedFiles(repoRoot, "main");
    expect(entries).toEqual([{ path: "docs/日本語.md", addedLines: 1, deletedLines: 0 }]);
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

describe("getMergeBase", () => {
  it("base と HEAD の共通の祖先 commit SHA を返す", async () => {
    await writeRaw(repoRoot, "base.txt", "v1\n");
    await gitCommitAll(repoRoot, "init");
    // このコミット SHA が merge-base になるはず。
    const headSha = await gitRevParse(repoRoot, "HEAD");

    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "feature.txt", "feature change\n");
    await gitCommitAll(repoRoot, "feat: add feature file");

    const mergeBase = await getMergeBase(repoRoot, "main");
    expect(mergeBase).toBe(headSha);
  });

  it("base 側が HEAD 後に進んでいても、分岐した時点の commit を返す（PR からは書き換えられない基準点）", async () => {
    await writeRaw(repoRoot, "base.txt", "v1\n");
    await gitCommitAll(repoRoot, "init");
    const branchPointSha = await gitRevParse(repoRoot, "HEAD");

    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "feature.txt", "feature change\n");
    await gitCommitAll(repoRoot, "feat: add feature file");

    await gitCheckout(repoRoot, "main");
    await writeRaw(repoRoot, "base.txt", "v2 (main progressed)\n");
    await gitCommitAll(repoRoot, "chore: progress main after branch");

    await gitCheckout(repoRoot, "feature");
    const mergeBase = await getMergeBase(repoRoot, "main");
    expect(mergeBase).toBe(branchPointSha);
  });

  it("base ref が解決できなければ GitDiffError（code: GIT_MERGE_BASE_FAILED）", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");

    await expect(getMergeBase(repoRoot, "does-not-exist-ref")).rejects.toMatchObject({
      code: "GIT_MERGE_BASE_FAILED",
    });
  });
});

describe("readFileAtRevision", () => {
  it("指定 revision でのファイル内容を返す", async () => {
    await writeRaw(repoRoot, ".ai/project.yaml", "project:\n  risk_level: medium\n");
    await gitCommitAll(repoRoot, "chore: add project.yaml");
    const mergeBase = await getMergeBase(repoRoot, "main");

    const text = await readFileAtRevision(repoRoot, mergeBase, ".ai/project.yaml");
    expect(text).toBe("project:\n  risk_level: medium\n");
  });

  it("PR HEAD で変更されても、指定した revision（merge-base）時点の内容を返す（自己改変耐性の土台）", async () => {
    await writeRaw(repoRoot, ".ai/project.yaml", "project:\n  risk_level: medium\n");
    await gitCommitAll(repoRoot, "chore: strict base config");
    const mergeBase = await getMergeBase(repoRoot, "main");

    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, ".ai/project.yaml", "project:\n  risk_level: low\n");
    await gitCommitAll(repoRoot, "chore: self-modify project.yaml (attack)");

    // HEAD（feature の working tree 相当）では書き換わっているが、merge-base 時点の内容は不変。
    const atMergeBase = await readFileAtRevision(repoRoot, mergeBase, ".ai/project.yaml");
    expect(atMergeBase).toBe("project:\n  risk_level: medium\n");
    const atHead = await readFileAtRevision(repoRoot, "HEAD", ".ai/project.yaml");
    expect(atHead).toBe("project:\n  risk_level: low\n");
  });

  it("revision にファイルが存在しなければ null", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");

    const text = await readFileAtRevision(repoRoot, "HEAD", ".ai/project.yaml");
    expect(text).toBeNull();
  });

  it("working tree にだけ存在し commit されていないファイルは revision に存在しないので null", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");
    // commit しない（working tree にだけ存在させる）。
    await writeRaw(repoRoot, "uncommitted.txt", "not committed\n");

    const text = await readFileAtRevision(repoRoot, "HEAD", "uncommitted.txt");
    expect(text).toBeNull();
  });

  it("revision 自体が解決できなければ GitDiffError（code: GIT_SHOW_FAILED）", async () => {
    await writeRaw(repoRoot, "a.txt", "line1\n");
    await gitCommitAll(repoRoot, "init");

    await expect(readFileAtRevision(repoRoot, "does-not-exist-rev", "a.txt")).rejects.toMatchObject({
      code: "GIT_SHOW_FAILED",
    });
  });
});

describe("readTreeEntryAtRevision / readBlobObject", () => {
  it.each([
    ["41桁", "a".repeat(41)],
    ["63桁", "b".repeat(63)],
  ])("%sのobject IDを完全長SHAとして受理しない", async (_label, objectId) => {
    await expect(readBlobObject(repoRoot, objectId)).rejects.toMatchObject({
      code: "GIT_BLOB_ID_INVALID",
    });
  });

  it("通常fileのGit mode・object id・raw bytesを返す", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a]);
    await writeFile(path.join(repoRoot, "binary.dat"), bytes);
    await gitCommitAll(repoRoot, "chore: add raw blob");

    const entry = await readTreeEntryAtRevision(repoRoot, "HEAD", "binary.dat");
    expect(entry).toMatchObject({ mode: "100644", type: "blob" });
    expect(entry === null ? false : isRegularGitTreeEntry(entry)).toBe(true);
    expect(await readBlobObject(repoRoot, entry?.objectId ?? "")).toEqual(bytes);
  });

  it("symlinkを通常fileと区別できるmodeで返す", async () => {
    await writeRaw(repoRoot, "target.txt", "target\n");
    await symlink("target.txt", path.join(repoRoot, "link.txt"));
    await gitCommitAll(repoRoot, "chore: add symlink");

    const entry = await readTreeEntryAtRevision(repoRoot, "HEAD", "link.txt");
    expect(entry).toMatchObject({
      mode: "120000",
      type: "blob",
    });
    expect(entry === null ? false : isRegularGitTreeEntry(entry)).toBe(false);
  });

  it("revisionにpathが存在しなければnull", async () => {
    await writeRaw(repoRoot, "a.txt", "a\n");
    await gitCommitAll(repoRoot, "init");

    await expect(readTreeEntryAtRevision(repoRoot, "HEAD", "missing.txt")).resolves.toBeNull();
  });

  it("pathspec記号をglobとして展開せずliteral pathとして扱う", async () => {
    await writeRaw(repoRoot, "docs/a.md", "a\n");
    await writeRaw(repoRoot, "docs/b.md", "b\n");
    await gitCommitAll(repoRoot, "docs: add files");

    await expect(readTreeEntryAtRevision(repoRoot, "HEAD", "docs/*.md")).resolves.toBeNull();
  });

  it("安全でない相対pathをgitへ渡す前に拒否する", async () => {
    await writeRaw(repoRoot, "a.txt", "a\n");
    await gitCommitAll(repoRoot, "init");

    await expect(readTreeEntryAtRevision(repoRoot, "HEAD", "../a.txt")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL",
    });
  });
});
