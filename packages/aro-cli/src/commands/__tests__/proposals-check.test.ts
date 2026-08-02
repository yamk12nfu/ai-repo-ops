import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeProposalsCheck,
  PROPOSALS_CHECK_EXIT,
  type ProposalsCheckIo,
  type ProposalsCheckOptions,
} from "../proposals-check.js";
import { PROPOSALS_ROOT } from "../../core/proposal-frontmatter.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import { gitCommitAll, gitRevParse, initRealGitRepo } from "../../test-support/git.fixture.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-proposals-check-cmd-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<ProposalsCheckOptions> = {}): ProposalsCheckOptions {
  return {
    repo: repoRoot,
    strict: false,
    json: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: ProposalsCheckIo; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      color: false,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function seedProposal(status: string, decision: string): Promise<void> {
  await writeRaw(repoRoot, "src/auth.ts", "v1\n");
  await gitCommitAll(repoRoot, "feat: source");
  const commit = await gitRevParse(repoRoot, "HEAD");
  await writeRaw(
    repoRoot,
    `${PROPOSALS_ROOT}/2026-08-sample.md`,
    `---
schema_version: 1
id: sample-proposal
status: ${status}
proposed_at_commit: ${commit}
sources:
  - path: src/auth.ts
${decision}
---

## 課題

テスト用。
`,
  );
}

describe("executeProposalsCheck", () => {
  it("freshな提案はexit 0とhuman PASSを返す", async () => {
    await seedProposal("open", 'decision:\n  by: ""\n  reason: ""');
    const cap = captureIo();

    const code = await executeProposalsCheck(options(), cap.io);

    expect(code).toBe(PROPOSALS_CHECK_EXIT.ok);
    expect(cap.out()).toContain("ai-repo-ops proposals check");
    expect(cap.out()).toContain("PASS");
    expect(cap.out()).toContain("1 proposals");
    expect(cap.out()).toContain("0 warnings");
    expect(cap.err()).toBe("");
  });

  it("提案0件（ディレクトリ不在）はexit 0でPASSする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const cap = captureIo();

    const code = await executeProposalsCheck(options({ strict: true }), cap.io);

    expect(code).toBe(PROPOSALS_CHECK_EXIT.ok);
    expect(cap.out()).toContain("0 proposals");
    expect(cap.out()).toContain("0 failed");
  });

  it("schema違反はexit 1と違反一覧を返す", async () => {
    await seedProposal("accepted", 'decision:\n  by: ""\n  reason: ""');
    const cap = captureIo();

    const code = await executeProposalsCheck(options(), cap.io);

    expect(code).toBe(PROPOSALS_CHECK_EXIT.failures);
    expect(cap.out()).toContain("FAIL");
    expect(cap.out()).toContain("decision.by");
  });

  it("通常モードのstaleはWARNだがexit 0", async () => {
    await seedProposal("open", 'decision:\n  by: ""\n  reason: ""');
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");
    const cap = captureIo();

    const code = await executeProposalsCheck(options(), cap.io);

    expect(code).toBe(PROPOSALS_CHECK_EXIT.ok);
    expect(cap.out()).toContain("WARN");
  });

  it("strictモードのstaleはexit 1", async () => {
    await seedProposal("open", 'decision:\n  by: ""\n  reason: ""');
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");
    const cap = captureIo();

    const code = await executeProposalsCheck(options({ strict: true }), cap.io);

    expect(code).toBe(PROPOSALS_CHECK_EXIT.failures);
    expect(cap.out()).toContain("FAIL");
  });

  it("--jsonは安定したenvelopeをstdoutへ返す", async () => {
    await seedProposal("open", 'decision:\n  by: ""\n  reason: ""');
    const cap = captureIo();

    const code = await executeProposalsCheck(options({ json: true }), cap.io);
    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      strict: boolean;
      report: { summary: { entries: number; failed: number } };
    };

    expect(code).toBe(PROPOSALS_CHECK_EXIT.ok);
    expect(parsed.command).toBe("proposals check");
    expect(parsed.ok).toBe(true);
    expect(parsed.strict).toBe(false);
    expect(parsed.report.summary.entries).toBe(1);
    expect(parsed.report.summary.failed).toBe(0);
  });

  it("Git repoでない対象はexit 3とJSON errorをstderrへ返す", async () => {
    const notGitRepo = await makeTempDir("aro-proposals-not-git-");
    try {
      const cap = captureIo();

      const code = await executeProposalsCheck(options({ repo: notGitRepo, json: true }), cap.io);

      expect(code).toBe(PROPOSALS_CHECK_EXIT.unexpected);
      const parsed = JSON.parse(cap.err()) as {
        command: string;
        ok: boolean;
        error: { code: string };
      };
      expect(parsed.command).toBe("proposals check");
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("REPO_NOT_GIT");
    } finally {
      await rm(notGitRepo, { recursive: true, force: true });
    }
  });
});
