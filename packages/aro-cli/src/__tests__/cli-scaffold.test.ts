import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ARO_CLI_VERSION, buildProgram } from "../main.js";
import { initGitRepo, makeTempDir, writeRaw } from "../test-support/distribution.fixture.js";
import { gitCommitAll, gitRevParse, initRealGitRepo } from "../test-support/git.fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLAN_BASE = [
  "---",
  "schema_version: 1",
  "id: demo-plan",
  "status: active",
  "current_stage: dry-run",
  "next_action:",
  "  id: inspect-runtime",
  "updated_at: 2026-08-17",
  "proposals: []",
  "permissions:",
  "  commit: false",
  "  push: false",
  "  draft_pr: false",
  "  merge: false",
  "stages:",
  "  - id: dry-run",
  "    status: active",
  "---",
  "",
].join("\n");

function planDocument(replacements: readonly [string, string][] = []): string {
  return replacements.reduce((document, [from, to]) => document.replace(from, to), PLAN_BASE);
}

function proposalDocument(id: string, status: string, commit: string, source: string): string {
  return [
    "---", "schema_version: 1", "id: " + id, "status: " + status,
    "proposed_at_commit: \"" + commit + "\"", "sources:", "  - path: " + source,
    "decision:", "  by: tester", "---", "",
  ].join("\n");
}

async function checkJson(repo: string, strict = false): Promise<{ ok: boolean; report: { findings: { id: string }[] } }> {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  await buildProgram().parseAsync(["node", "aro", "plans", "check", "--repo", repo, "--json", ...(strict ? ["--strict"] : [])]);
  return JSON.parse(output.join("")) as { ok: boolean; report: { findings: { id: string }[] } };
}

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("aro CLI scaffold", () => {
  it("トップレベルコマンドを登録している", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(["diff", "doctor", "guard", "init", "knowledge", "plans", "proposals", "sync"]);
  });

  it("--help に各コマンドと概要を含む", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("init");
    expect(help).toContain("diff");
    expect(help).toContain("sync");
    expect(help).toContain("doctor");
    expect(help).toContain("guard");
    expect(help).toContain("knowledge");
    expect(help).toContain("proposals");
    expect(help).toContain("aro");
  });

  it("CLIバージョンを公開している", () => {
    expect(buildProgram().version()).toBe(ARO_CLI_VERSION);
  });

  it("CLIバージョンが package.json と一致する", () => {
    // 固定値でアサートすると bump 漏れを検出できない（0.2.0 のまま 2 リリース通過した）。
    // package.json を独立に読み、導出元とのズレだけを検証する。
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

    expect(ARO_CLI_VERSION).toBe(pkg.version);
    expect(ARO_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("diff は --detailed-exitcode オプションを持つ", () => {
    const diff = buildProgram().commands.find((command) => command.name() === "diff");
    expect(diff).toBeDefined();
    const help = diff?.helpInformation() ?? "";
    expect(help).toContain("--detailed-exitcode");
  });

  it("guard は必須の --base オプションを持つ", () => {
    const guard = buildProgram().commands.find((command) => command.name() === "guard");
    expect(guard).toBeDefined();
    const help = guard?.helpInformation() ?? "";
    expect(help).toContain("--base <ref>");
  });

  it("knowledge は init / check サブコマンドを持つ", () => {
    const knowledge = buildProgram().commands.find((command) => command.name() === "knowledge");
    expect(knowledge).toBeDefined();
    expect(knowledge?.commands.map((command) => command.name()).sort()).toEqual(["check", "init"]);

    const initHelp = knowledge?.commands.find((command) => command.name() === "init")?.helpInformation() ?? "";
    const checkHelp = knowledge?.commands.find((command) => command.name() === "check")?.helpInformation() ?? "";
    expect(initHelp).toContain("--dry-run");
    expect(initHelp).toContain("--json");
    expect(initHelp).toContain("--base <ref>");
    const baseOption = knowledge?.commands
      .find((command) => command.name() === "init")
      ?.options.find((option) => option.long === "--base");
    expect(baseOption?.mandatory).toBe(true);
    expect(checkHelp).toContain("--strict");
    expect(checkHelp).toContain("--json");
  });

  it("proposals は check サブコマンドを持つ", () => {
    const proposals = buildProgram().commands.find((command) => command.name() === "proposals");
    expect(proposals).toBeDefined();
    expect(proposals?.commands.map((command) => command.name())).toEqual(["check"]);

    const checkHelp =
      proposals?.commands.find((command) => command.name() === "check")?.helpInformation() ?? "";
    expect(checkHelp).toContain("--repo");
    expect(checkHelp).toContain("--strict");
    expect(checkHelp).toContain("--json");
  });

  it("plans は check / status / next サブコマンドを持つ", () => {
    const plans = buildProgram().commands.find((command) => command.name() === "plans");
    expect(plans?.commands.map((command) => command.name()).sort()).toEqual(["check", "next", "status"]);
  });

  it("plans の各サブコマンドは --repo と --json を受け付ける", () => {
    const plans = buildProgram().commands.find((command) => command.name() === "plans");
    for (const name of ["check", "status", "next"]) {
      const command = plans?.commands.find((candidate) => candidate.name() === name);
      expect(command?.options.some((option) => option.long === "--repo")).toBe(true);
      expect(command?.options.some((option) => option.long === "--json")).toBe(true);
    }
    const checkHelp = plans?.commands.find((command) => command.name() === "check")?.helpInformation() ?? "";
    expect(checkHelp).toContain("current action");
    expect(checkHelp).toContain("Proposal");
    expect(checkHelp).toContain("readiness/freshness");
  });

  it("plans check はplanが無いrepoを正常な空状態として表示する", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await buildProgram().parseAsync(["node", "aro", "plans", "check", "--repo", REPO_ROOT]);

    expect(process.exitCode).toBe(0);
    expect(output.join("")).toContain("0 plans");
  });

  it("plans check --strict はplanが無いrepoも正常な空状態として扱う", async () => {
    const result = await checkJson(REPO_ROOT, true);
    expect(result.ok).toBe(true);
  });

  it("plans check は1件のactive planとcurrent stageをJSONで返す", async () => {
    const repo = await makeTempDir("aro-plans-valid-");
    try {
      await initGitRepo(repo);
      await writeRaw(
        repo,
        ".ai/local/execution-plans/demo.md",
        `---
schema_version: 1
id: demo-plan
status: active
current_stage: dry-run
next_action:
  id: inspect-runtime
updated_at: 2026-08-17
proposals: []
permissions:
  commit: false
  push: false
  draft_pr: false
  merge: false
stages:
  - id: dry-run
    status: active
---
`,
      );
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await buildProgram().parseAsync(["node", "aro", "plans", "check", "--repo", repo, "--json"]);

      const result = JSON.parse(output.join("")) as {
        ok: boolean;
        report: { summary: { plans: number; failed: number }; plans: string[] };
      };
      expect(result.ok).toBe(true);
      expect(result.report.summary).toEqual({ plans: 1, failed: 0 });
      expect(result.report.plans).toEqual(["demo-plan"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はactive stageが複数のplanをinvariant違反にする", async () => {
    const repo = await makeTempDir("aro-plans-invalid-");
    try {
      await initGitRepo(repo);
      await writeRaw(
        repo,
        ".ai/local/execution-plans/demo.md",
        planDocument([[
          "  - id: dry-run\n    status: active",
          "  - id: dry-run\n    status: active\n  - id: later\n    status: active",
        ]]),
      );
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "check", "--repo", repo, "--json"]);
      const result = JSON.parse(output.join("")) as {
        ok: boolean;
        report: { findings: { id: string }[] };
      };
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("stage.active-count");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はstage IDの重複を拒否する", async () => {
    const repo = await makeTempDir("aro-plans-stage-duplicate-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([[
        "  - id: dry-run\n    status: active",
        "  - id: dry-run\n    status: completed\n  - id: dry-run\n    status: active",
      ]]));
      const result = await checkJson(repo);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("stage.id-duplicate");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はpermissions.merge=trueを拒否する", async () => {
    const repo = await makeTempDir("aro-plans-merge-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([["  merge: false", "  merge: true"]]));
      const result = await checkJson(repo);
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("permissions.merge");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check のhuman出力はfindingのIDとmessageを表示する", async () => {
    const repo = await makeTempDir("aro-plans-human-finding-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([["  merge: false", "  merge: true"]]));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "check", "--repo", repo]);
      expect(output.join("")).toContain("FAIL  permissions.merge:");
      expect(output.join("")).toContain("permissions.merge: true はv1では許可されません");
      expect(output.join("")).not.toContain("[object Object]");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check --strict はcurrent actionのProposal blockerを検証する", async () => {
    const repo = await makeTempDir("aro-plans-strict-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: missing-proposal"],
        ["proposals: []", "proposals:\n  - missing-proposal"],
      ]));
      const result = await checkJson(repo, true);
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("next.proposal-missing");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はterminal planのcurrent/next/active stageを拒否する", async () => {
    const repo = await makeTempDir("aro-plans-terminal-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([["status: active", "status: completed"]]));
      const result = await checkJson(repo);
      const ids = result.report.findings.map((candidate) => candidate.id);
      expect(result.ok).toBe(false);
      expect(ids).toEqual(expect.arrayContaining(["terminal.current-stage", "terminal.next-action", "terminal.stage"]));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はblocked planにblocked stageを要求する", async () => {
    const repo = await makeTempDir("aro-plans-blocked-invariant-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([["status: active", "status: blocked"]]));
      const result = await checkJson(repo);
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("stage.blocked-count");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check はstage列をcompletedからpendingへ逆行させない", async () => {
    const repo = await makeTempDir("aro-plans-stage-order-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["status: active", "status: completed"],
        ["  - id: dry-run\n    status: active", "  - id: future\n    status: pending\n  - id: done\n    status: completed"],
      ]));
      const result = await checkJson(repo);
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("stage.order");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans status はactive planの現在stageをJSONで返す", async () => {
    const repo = await makeTempDir("aro-plans-status-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument());
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "status", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"command": "plans status"');
      expect(output.join("")).toContain("demo-plan");
      expect(output.join("")).toContain("dry-run");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はvalid active planのstructured actionをrunnableとして返す", async () => {
    const repo = await makeTempDir("aro-plans-next-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument());
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"runnable": true');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はplanが無いrepoをno-active-planでblockする", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", REPO_ROOT, "--json"]);
    const result = JSON.parse(output.join("")) as {
      ok: boolean;
      runnable: boolean;
      blockers: { code: string }[];
    };
    expect(process.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.runnable).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toContain("no-active-plan");
  });

  it("plans next は複数active planを自動選択しない", async () => {
    const repo = await makeTempDir("aro-plans-multiple-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/a.md", planDocument());
      await writeRaw(repo, ".ai/local/execution-plans/b.md", planDocument([["id: demo-plan", "id: second-plan"]]));
      const checked = await checkJson(repo);
      expect(checked.ok).toBe(false);
      expect(checked.report.findings.map((candidate) => candidate.id)).toContain("plan.active-multiple");
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"runnable": false');
      expect(output.join("")).toContain('"code": "multiple-active-plans"');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はblocked planをplan-blockedとして返す", async () => {
    const repo = await makeTempDir("aro-plans-blocked-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["status: active", "status: blocked"],
        ["    status: active", "    status: blocked"],
      ]));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"code": "plan-blocked"');
      expect(output.join("")).toContain('"runnable": false');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はactive planがあればblocked planを選択しない", async () => {
    const repo = await makeTempDir("aro-plans-active-and-blocked-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/active.md", planDocument());
      await writeRaw(repo, ".ai/local/execution-plans/blocked.md", planDocument([
        ["id: demo-plan", "id: blocked-plan"],
        ["status: active", "status: blocked"],
        ["    status: active", "    status: blocked"],
      ]));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      const result = JSON.parse(output.join("")) as {
        plan: { id: string; status: string } | null;
        runnable: boolean;
        blockers: { code: string }[];
      };
      expect(result.plan).toEqual({ id: "demo-plan", status: "active" });
      expect(result.runnable).toBe(true);
      expect(result.blockers).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next は参照Proposal不存在をproposal-missingでblockする", async () => {
    const repo = await makeTempDir("aro-plans-proposal-missing-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: missing-proposal"],
        ["proposals: []", "proposals:\n  - missing-proposal"],
      ]));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"runnable": false');
      expect(output.join("")).toContain('"code": "proposal-missing"');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はProposalがacceptedでない場合をblockする", async () => {
    const repo = await makeTempDir("aro-plans-proposal-open-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: open-proposal"],
        ["proposals: []", "proposals:\n  - open-proposal"],
      ]));
      await writeRaw(repo, ".ai/local/proposals/open.md", [
        "---", "schema_version: 1", "id: open-proposal", "status: open",
        "proposed_at_commit: \"0000000000000000000000000000000000000000\"",
        "sources:", "  - path: README.md", "---", "",
      ].join("\n"));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"code": "proposal-not-accepted"');
      expect(output.join("")).toContain('"runnable": false');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はaccepted Proposalのstale sourceをproposal-staleでblockする", async () => {
    const repo = await makeTempDir("aro-plans-proposal-stale-");
    try {
      await initRealGitRepo(repo);
      await writeRaw(repo, "src/input.txt", "v1\n");
      await gitCommitAll(repo, "source");
      const commit = await gitRevParse(repo, "HEAD");
      await writeRaw(repo, ".ai/local/proposals/stale.md", proposalDocument("stale-proposal", "accepted", commit, "src/input.txt"));
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: stale-proposal"],
        ["proposals: []", "proposals:\n  - stale-proposal"],
      ]));
      await writeRaw(repo, "src/input.txt", "v2\n");
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"code": "proposal-stale"');
      expect(output.join("")).toContain('"runnable": false');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はProposal freshness判定不能を別blockerにする", async () => {
    const repo = await makeTempDir("aro-plans-proposal-unknown-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: unknown-proposal"],
        ["proposals: []", "proposals:\n  - unknown-proposal"],
      ]));
      await writeRaw(repo, ".ai/local/proposals/unknown.md", proposalDocument(
        "unknown-proposal", "accepted", "0000000000000000000000000000000000000000", "README.md",
      ));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      expect(output.join("")).toContain('"code": "proposal-freshness-undeterminable"');
      expect(output.join("")).toContain('"runnable": false');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next は同じProposal IDの重複をfreshness判定不能としてblockする", async () => {
    const repo = await makeTempDir("aro-plans-duplicate-proposal-");
    try {
      await initRealGitRepo(repo);
      await writeRaw(repo, "src/input.txt", "v1\n");
      await gitCommitAll(repo, "source");
      const commit = await gitRevParse(repo, "HEAD");
      const proposal = proposalDocument("duplicate-proposal", "accepted", commit, "src/input.txt");
      await writeRaw(repo, ".ai/local/proposals/a.md", proposal);
      await writeRaw(repo, ".ai/local/proposals/b.md", proposal);
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: duplicate-proposal"],
        ["proposals: []", "proposals:\n  - duplicate-proposal"],
      ]));
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
      const result = JSON.parse(output.join("")) as {
        runnable: boolean;
        blockers: { code: string; message: string }[];
      };
      expect(result.runnable).toBe(false);
      expect(result.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "proposal-freshness-undeterminable",
          message: expect.stringContaining("複数"),
        }),
      ]));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans next はfuture stageのProposalをcurrent actionのblockerにしない", async () => {
    const repo = await makeTempDir("aro-plans-future-proposal-");
    try {
      await initRealGitRepo(repo);
      await writeRaw(repo, "src/input.txt", "v1\n");
      await gitCommitAll(repo, "source");
      const commit = await gitRevParse(repo, "HEAD");
      await writeRaw(repo, ".ai/local/proposals/current.md", proposalDocument("current-proposal", "accepted", commit, "src/input.txt"));
      await writeRaw(repo, ".ai/local/execution-plans/demo.md", planDocument([
        ["  id: inspect-runtime", "  id: inspect-runtime\n  proposal_id: current-proposal"],
        ["proposals: []", "proposals:\n  - current-proposal\n  - future-proposal"],
        ["  - id: dry-run\n    status: active", "  - id: dry-run\n    status: active\n  - id: future\n    status: pending\n    proposal_id: future-proposal"],
      ]));
      const result = await (async () => {
        const output: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          output.push(String(chunk));
          return true;
        });
        await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", repo, "--json"]);
        return JSON.parse(output.join("")) as { runnable: boolean; blockers: { proposal_id?: string }[] };
      })();
      expect(result.runnable).toBe(true);
      expect(result.blockers).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans check は重複したexecution plan IDを拒否する", async () => {
    const repo = await makeTempDir("aro-plans-duplicate-id-");
    try {
      await initGitRepo(repo);
      await writeRaw(repo, ".ai/local/execution-plans/active.md", planDocument());
      await writeRaw(repo, ".ai/local/execution-plans/blocked.md", planDocument([
        ["status: active", "status: blocked"],
        ["    status: active", "    status: blocked"],
      ]));
      const result = await checkJson(repo);
      expect(result.ok).toBe(false);
      expect(result.report.findings.map((candidate) => candidate.id)).toContain("plan.id-duplicate");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("plans status/next はhuman向けcommand headerを返す", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await buildProgram().parseAsync(["node", "aro", "plans", "status", "--repo", REPO_ROOT]);
    await buildProgram().parseAsync(["node", "aro", "plans", "next", "--repo", REPO_ROOT]);
    expect(output.join("")).toContain("ai-repo-ops plans status");
    expect(output.join("")).toContain("ai-repo-ops plans next");
  });
});
