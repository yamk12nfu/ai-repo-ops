import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepoError } from "../errors.js";
import { assertGitRepo, resolveRepoRoot } from "../git.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aro-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveRepoRoot", () => {
  it("存在しない path は REPO_NOT_FOUND", async () => {
    await expect(resolveRepoRoot(path.join(dir, "nope"))).rejects.toMatchObject({
      code: "REPO_NOT_FOUND",
    });
  });

  it("ファイル（ディレクトリでない）は REPO_NOT_DIRECTORY", async () => {
    const file = path.join(dir, "afile");
    await writeFile(file, "x", "utf8");
    await expect(resolveRepoRoot(file)).rejects.toMatchObject({ code: "REPO_NOT_DIRECTORY" });
  });

  it("存在するディレクトリは絶対 path を返す", async () => {
    await expect(resolveRepoRoot(dir)).resolves.toBe(path.resolve(dir));
  });
});

describe("assertGitRepo", () => {
  it(".git が無いディレクトリは REPO_NOT_GIT", async () => {
    await expect(assertGitRepo(dir)).rejects.toBeInstanceOf(RepoError);
    await expect(assertGitRepo(dir)).rejects.toMatchObject({ code: "REPO_NOT_GIT" });
  });

  it(".git ディレクトリがあれば Git repo とみなす", async () => {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await expect(assertGitRepo(dir)).resolves.toBe(path.resolve(dir));
  });

  it(".git ファイル（worktree）があっても Git repo とみなす", async () => {
    await writeFile(path.join(dir, ".git"), "gitdir: /elsewhere\n", "utf8");
    await expect(assertGitRepo(dir)).resolves.toBe(path.resolve(dir));
  });

  it("存在しない path は REPO_NOT_FOUND（resolveRepoRoot 由来）", async () => {
    await expect(assertGitRepo(path.join(dir, "missing"))).rejects.toMatchObject({
      code: "REPO_NOT_FOUND",
    });
  });
});
