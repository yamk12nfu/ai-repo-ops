import { rm, symlink } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectKnowledgeSourceGit } from "../knowledge-git.js";
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
  repoRoot = await makeTempDir("aro-knowledge-git-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("inspectKnowledgeSourceGit", () => {
  it("HEADで追跡され検証commitから不変のsourceをfreshと判定する", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "export const auth = true;\n");
    await gitCommitAll(repoRoot, "feat: add auth");
    const verified = await gitRevParse(repoRoot, "HEAD");

    await expect(inspectKnowledgeSourceGit(repoRoot, "src/auth.ts", verified)).resolves.toMatchObject({
      commitState: "ancestor",
      trackedAtHead: true,
      existsAtVerifiedCommit: true,
      stale: false,
    });
  });

  it("検証commit以降のworking tree変更をstaleと判定する", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "v1\n");
    await gitCommitAll(repoRoot, "feat: add auth");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");

    expect(await inspectKnowledgeSourceGit(repoRoot, "src/auth.ts", verified)).toMatchObject({
      commitState: "ancestor",
      stale: true,
    });
  });

  it("検証commit以降にcommitされた変更をstaleと判定する", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "v1\n");
    await gitCommitAll(repoRoot, "feat: add auth");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");
    await gitCommitAll(repoRoot, "refactor: update auth");

    expect(await inspectKnowledgeSourceGit(repoRoot, "src/auth.ts", verified)).toMatchObject({
      trackedAtHead: true,
      existsAtVerifiedCommit: true,
      stale: true,
    });
  });

  it("検証commitに存在しなかったsourceを区別する", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "src/new.ts", "export {};\n");
    await gitCommitAll(repoRoot, "feat: add source later");

    await expect(inspectKnowledgeSourceGit(repoRoot, "src/new.ts", verified)).resolves.toMatchObject({
      commitState: "ancestor",
      trackedAtHead: true,
      existsAtVerifiedCommit: false,
      stale: true,
    });
  });

  it("HEADで未追跡のsourceを区別する", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "notes.txt", "untracked\n");

    expect(await inspectKnowledgeSourceGit(repoRoot, "notes.txt", verified)).toMatchObject({
      trackedAtHead: false,
      existsAtVerifiedCommit: false,
    });
  });

  it("存在しない検証commitをmissingとして返す", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");

    await expect(
      inspectKnowledgeSourceGit(repoRoot, "README.md", "ffffffffffffffffffffffffffffffffffffffff"),
    ).resolves.toMatchObject({
      commitState: "missing",
      trackedAtHead: true,
      existsAtVerifiedCommit: null,
      stale: null,
    });
  });

  it("HEADと別系統の検証commitをnot-ancestorとして返す", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "v1\n");
    await gitCommitAll(repoRoot, "feat: add auth");
    await gitCheckoutNewBranch(repoRoot, "side");
    await writeRaw(repoRoot, "side.txt", "side\n");
    await gitCommitAll(repoRoot, "chore: side commit");
    const sideCommit = await gitRevParse(repoRoot, "HEAD");
    await gitCheckout(repoRoot, "main");

    await expect(inspectKnowledgeSourceGit(repoRoot, "src/auth.ts", sideCommit)).resolves.toMatchObject({
      commitState: "not-ancestor",
      trackedAtHead: true,
      existsAtVerifiedCommit: true,
      stale: null,
    });
  });

  it("HEADとverification commitのGit tree entryを区別して返す", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await symlink("../README.md", `${repoRoot}/src-link`);
    await gitCommitAll(repoRoot, "chore: add symlink source");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await rm(`${repoRoot}/src-link`);
    await writeRaw(repoRoot, "src-link", "regular source\n");
    await gitCommitAll(repoRoot, "fix: replace symlink with file");

    const state = await inspectKnowledgeSourceGit(repoRoot, "src-link", verified);

    expect(state.headEntry).toMatchObject({ mode: "100644", type: "blob" });
    expect(state.verifiedEntry).toMatchObject({ mode: "120000", type: "blob" });
  });

  it("directory pathをtree entryとして返す", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "export {};\n");
    await gitCommitAll(repoRoot, "feat: add source tree");
    const verified = await gitRevParse(repoRoot, "HEAD");

    const state = await inspectKnowledgeSourceGit(repoRoot, "src", verified);

    expect(state.headEntry).toMatchObject({ mode: "040000", type: "tree" });
    expect(state.verifiedEntry).toMatchObject({ mode: "040000", type: "tree" });
  });
});
