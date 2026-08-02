import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProposalsCheck, type ProposalsReport } from "../proposals-check.js";
import { PROPOSALS_ROOT, type ProposalStatus } from "../proposal-frontmatter.js";
import { makeTempDir, writeRaw, writeRawBytes } from "../../test-support/distribution.fixture.js";
import {
  gitCheckout,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitRevParse,
  initRealGitRepo,
} from "../../test-support/git.fixture.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-proposals-check-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function finding(report: ProposalsReport, id: string) {
  return report.findings.find((candidate) => candidate.id === id);
}

function proposalMarkdown(options: {
  id: string;
  status: ProposalStatus | string;
  commit: string;
  sourcePaths?: readonly string[];
  by?: string;
  reason?: string;
}): string {
  const sources = (options.sourcePaths ?? ["src/auth.ts"])
    .map((sourcePath) => `  - path: ${sourcePath}`)
    .join("\n");
  return `---
schema_version: 1
id: ${options.id}
status: ${options.status}
proposed_at_commit: ${options.commit}
sources:
${sources}
decision:
  by: "${options.by ?? ""}"
  reason: "${options.reason ?? ""}"
---

## 課題

テスト用の提案。
`;
}

/** src/auth.ts をcommitし、そのcommit SHAを返す。 */
async function seedSource(): Promise<string> {
  await writeRaw(repoRoot, "src/auth.ts", "export const auth = true;\n");
  await gitCommitAll(repoRoot, "feat: add auth source");
  return gitRevParse(repoRoot, "HEAD");
}

describe("runProposalsCheck", () => {
  it("正常なopen提案はFAIL/WARNなしでPASSする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/2026-08-good.md`,
      proposalMarkdown({ id: "good-proposal", status: "open", commit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.summary.entries).toBe(1);
    expect(finding(report, "frontmatter.schema")?.status).toBe("pass");
    expect(finding(report, "source.fresh")?.status).toBe("pass");
  });

  it("提案ディレクトリ不在は正常な状態としてPASSする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");

    const report = await runProposalsCheck({ repoRoot, strict: true });

    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.summary.entries).toBe(0);
    expect(finding(report, "proposals.empty")?.status).toBe("pass");
  });

  it("提案0件（ディレクトリのみ）もPASSする", async () => {
    await writeRaw(repoRoot, `${PROPOSALS_ROOT}/.gitkeep`, "");

    const report = await runProposalsCheck({ repoRoot, strict: true });

    expect(report.hasFailures).toBe(false);
    expect(report.summary.entries).toBe(0);
    expect(finding(report, "proposals.empty")?.status).toBe("pass");
  });

  it("proposals rootが通常ファイルならproposals.rootでFAILにする", async () => {
    await seedSource();
    await writeRaw(repoRoot, `${PROPOSALS_ROOT}`, "not a directory\n");

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(report.summary.entries).toBe(0);
    expect(finding(report, "proposals.root")?.status).toBe("fail");
    expect(finding(report, "proposals.empty")).toBeUndefined();
  });

  it("proposals rootがsymlinkなら追従せずproposals.rootでFAILにする", async () => {
    await seedSource();
    await writeRaw(repoRoot, ".ai/local/.keep", "");
    await symlink(path.join(repoRoot, "src"), path.join(repoRoot, PROPOSALS_ROOT));

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "proposals.root")?.status).toBe("fail");
    expect(finding(report, "proposals.root")?.hint).toContain("symlink");
  });

  it("proposals rootの親がsymlinkでもproposals.rootでFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      "real-local/proposals/good.md",
      proposalMarkdown({ id: "good-proposal", status: "open", commit }),
    );
    await mkdir(path.join(repoRoot, ".ai"), { recursive: true });
    await symlink(path.join(repoRoot, "real-local"), path.join(repoRoot, ".ai/local"));

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "proposals.root")?.status).toBe("fail");
  });

  it("大文字拡張子（.MD）の提案も列挙して検証する", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/UPPER.MD`,
      proposalMarkdown({ id: "upper-ext", status: "open", commit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.summary.entries).toBe(1);
    expect(report.hasFailures).toBe(false);
    expect(finding(report, "frontmatter.schema")?.status).toBe("pass");
    expect(finding(report, "proposals.empty")).toBeUndefined();
  });

  it("*.mdという名前のディレクトリをdocument.fileでFAILにする", async () => {
    await seedSource();
    await mkdir(path.join(repoRoot, PROPOSALS_ROOT, "foo.md"), { recursive: true });

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "document.file")?.status).toBe("fail");
    expect(finding(report, "proposals.empty")).toBeUndefined();
  });

  it("frontmatterが無いファイルをfrontmatter.parseでFAILにする", async () => {
    await seedSource();
    await writeRaw(repoRoot, `${PROPOSALS_ROOT}/no-frontmatter.md`, "# 提案\n本文だけ。\n");

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "frontmatter.parse")?.status).toBe("fail");
  });

  it("schema違反（未知のkey）をfrontmatter.schemaでFAILにする", async () => {
    const commit = await seedSource();
    const text = proposalMarkdown({ id: "bad-schema", status: "open", commit }).replace(
      "schema_version: 1",
      "schema_version: 1\nunexpected: true",
    );
    await writeRaw(repoRoot, `${PROPOSALS_ROOT}/bad-schema.md`, text);

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "frontmatter.schema")?.status).toBe("fail");
  });

  it("大文字を含むIDはschema段階でFAILになる（IDのcase違いはここで弾かれる）", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/upper.md`,
      proposalMarkdown({ id: "DUP-ID", status: "open", commit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "frontmatter.schema")?.status).toBe("fail");
  });

  it("open以外でdecision.byが空ならFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/accepted-no-by.md`,
      proposalMarkdown({ id: "accepted-no-by", status: "accepted", commit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "frontmatter.schema")?.status).toBe("fail");
  });

  it("rejectedでdecision.reasonが空ならFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/rejected-no-reason.md`,
      proposalMarkdown({ id: "rejected-no-reason", status: "rejected", commit, by: "alice" }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "frontmatter.schema")?.status).toBe("fail");
  });

  it("別ファイル間のID重複をid.duplicateでFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/2026-07-first.md`,
      proposalMarkdown({ id: "dup-id", status: "open", commit }),
    );
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/2026-08-second.md`,
      proposalMarkdown({ id: "dup-id", status: "open", commit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    const duplicate = finding(report, "id.duplicate");
    expect(duplicate?.status).toBe("fail");
    expect(duplicate?.entryId).toBe("dup-id");
    expect(duplicate?.hint).toContain("2026-07-first.md");
    expect(report.findings.filter((entry) => entry.id === "id.duplicate")).toHaveLength(1);
  });

  it("UTF-8テキストでない提案をdocument.textでFAILにする", async () => {
    await seedSource();
    await writeRawBytes(repoRoot, `${PROPOSALS_ROOT}/binary.md`, Buffer.from([0xff, 0xfe, 0xfd]));

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "document.text")?.status).toBe("fail");
  });

  it("symlinkの提案ファイルを追従せずdocument.readでFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/real.md`,
      proposalMarkdown({ id: "real-proposal", status: "open", commit }),
    );
    await symlink("real.md", path.join(repoRoot, PROPOSALS_ROOT, "link.md"));

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "document.read")?.status).toBe("fail");
  });

  it("HEADで追跡されていないsourceをsource.trackedでFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(repoRoot, "notes.txt", "untracked\n");
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/untracked.md`,
      proposalMarkdown({ id: "untracked-source", status: "open", commit, sourcePaths: ["notes.txt"] }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "source.tracked")?.status).toBe("fail");
  });

  it("Git上のsymlink sourceを通常blobではないとしてFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await symlink("README.md", path.join(repoRoot, "src-link"));
    await gitCommitAll(repoRoot, "chore: add symlink source");
    const commit = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/symlink-source.md`,
      proposalMarkdown({ id: "symlink-source", status: "open", commit, sourcePaths: ["src-link"] }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "source.git-object")?.status).toBe("fail");
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("禁止pathのsourceを読む前にFAILにする", async () => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/forbidden.md`,
      proposalMarkdown({ id: "forbidden-source", status: "open", commit, sourcePaths: ["secrets/token.txt"] }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "source.forbidden")?.status).toBe("fail");
  });

  it("存在しないproposed_at_commitをprovenance.commitでFAILにする", async () => {
    await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/missing-commit.md`,
      proposalMarkdown({
        id: "missing-commit",
        status: "open",
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(finding(report, "provenance.commit")?.status).toBe("fail");
  });

  it("HEADの祖先でないproposed_at_commitをprovenance.ancestorでFAILにする", async () => {
    await seedSource();
    await gitCheckoutNewBranch(repoRoot, "side");
    await writeRaw(repoRoot, "side.txt", "side\n");
    await gitCommitAll(repoRoot, "chore: side commit");
    const sideCommit = await gitRevParse(repoRoot, "HEAD");
    await gitCheckout(repoRoot, "main");
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/not-ancestor.md`,
      proposalMarkdown({ id: "not-ancestor", status: "open", commit: sideCommit }),
    );

    const report = await runProposalsCheck({ repoRoot, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "provenance.ancestor")?.status).toBe("fail");
  });

  it.each([
    ["open", undefined, undefined],
    ["accepted", "alice", undefined],
  ] as const)("%s のsource変更は通常モードでWARN・strictでFAILにする", async (status, by, reason) => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/stale.md`,
      proposalMarkdown({
        id: "stale-proposal",
        status,
        commit,
        ...(by !== undefined ? { by } : {}),
        ...(reason !== undefined ? { reason } : {}),
      }),
    );
    await writeRaw(repoRoot, "src/auth.ts", "export const auth = false;\n");

    const normal = await runProposalsCheck({ repoRoot, strict: false });
    expect(normal.hasFailures).toBe(false);
    expect(normal.hasWarnings).toBe(true);
    expect(finding(normal, "source.stale")?.status).toBe("warn");
    expect(normal.summary.stale).toBe(1);

    const strict = await runProposalsCheck({ repoRoot, strict: true });
    expect(strict.hasFailures).toBe(true);
    expect(finding(strict, "source.stale")?.status).toBe("fail");
  });

  it.each([
    ["rejected", "alice", "重複した提案のため却下"],
    ["done", "alice", undefined],
    ["superseded", "alice", "別提案で置き換え"],
  ] as const)("%s はsourceが変わってもstaleにしない", async (status, by, reason) => {
    const commit = await seedSource();
    await writeRaw(
      repoRoot,
      `${PROPOSALS_ROOT}/decided.md`,
      proposalMarkdown({
        id: "decided-proposal",
        status,
        commit,
        by,
        ...(reason !== undefined ? { reason } : {}),
      }),
    );
    await writeRaw(repoRoot, "src/auth.ts", "export const auth = false;\n");

    const report = await runProposalsCheck({ repoRoot, strict: true });

    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(finding(report, "source.stale")).toBeUndefined();
    expect(finding(report, "source.stale-exempt")?.status).toBe("pass");
  });
});
