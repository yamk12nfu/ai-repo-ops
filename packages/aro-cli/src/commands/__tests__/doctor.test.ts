import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeDoctor, DOCTOR_EXIT, type DoctorIo, type DoctorOptions } from "../doctor.js";
import { executeInit, type InitIo } from "../init.js";
import { resolveSourceRoot } from "../../core/source.js";
import {
  initGitRepo,
  makeTempDir,
  seedRepoAsSynced,
  setupBaseDistribution,
  writeRaw,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

const NOW = "2026-07-01T12:00:00.000Z";

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-doctor-cmd-src-");
  repoRoot = await makeTempDir("aro-doctor-cmd-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: DoctorIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: (text) => outChunks.push(text),
      stderr: (text) => errChunks.push(text),
      color: false,
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

describe("executeDoctor: validation / unexpected", () => {
  it("repo path が存在しなければ unexpected (exit 3)", async () => {
    await setupBaseDistribution(sourceRoot);
    const cap = captureIo();
    const code = await executeDoctor(options({ repo: path.join(repoRoot, "does-not-exist") }), cap.io);
    expect(code).toBe(DOCTOR_EXIT.unexpected);
    expect(cap.err()).toContain("ERROR");
  });

  it("--source が解決できなければ unexpected (exit 3)", async () => {
    await initGitRepo(repoRoot);
    const cap = captureIo();
    const code = await executeDoctor(options({ source: path.join(sourceRoot, "nope") }), cap.io);
    expect(code).toBe(DOCTOR_EXIT.unexpected);
  });
});

describe("executeDoctor: Git repo でない対象（診断項目としての FAIL、exit 1）", () => {
  it("Git repo でなくても診断は実行され FAIL を報告する（exit 1、unexpected の 3 ではない）", async () => {
    await setupBaseDistribution(sourceRoot);
    // initGitRepo を呼ばない。

    const cap = captureIo();
    const code = await executeDoctor(options(), cap.io);
    expect(code).toBe(DOCTOR_EXIT.hasFailures);
    expect(cap.out()).toContain("FAIL");
  });
});

describe("executeDoctor: fixture ベースの FAIL 検出", () => {
  it("lock も project.yaml も無ければ FAIL (exit 1)", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const cap = captureIo();
    const code = await executeDoctor(options(), cap.io);
    expect(code).toBe(DOCTOR_EXIT.hasFailures);
    expect(cap.out()).toContain("does not exist");
  });

  it("managed file を人間が編集すると FAIL (exit 1)、git restore を案内する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const { loadDistribution } = await import("../../core/source.js");
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);
    await writeRaw(repoRoot, ".ai/managed/prompts/review.md", "# Review prompt\nLOCAL EDIT\n");

    const cap = captureIo();
    const code = await executeDoctor(options(), cap.io);
    expect(code).toBe(DOCTOR_EXIT.hasFailures);
    expect(cap.out()).toContain("checksum mismatch");
    expect(cap.out()).toContain("git restore");
  });

  it("--json はレポートを JSON で出力する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const cap = captureIo();
    const code = await executeDoctor(options({ json: true }), cap.io);
    expect(code).toBe(DOCTOR_EXIT.hasFailures);

    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      report: { checks: Array<{ id: string; status: string }>; summary: { failed: number } };
    };
    expect(parsed.command).toBe("doctor");
    expect(parsed.ok).toBe(false);
    expect(parsed.report.summary.failed).toBeGreaterThan(0);
    expect(parsed.report.checks.some((c) => c.id === "lock.exists" && c.status === "fail")).toBe(true);
  });
});

describe("executeDoctor: 実 distribution/base に対するエンドツーエンド（Scenario 1 / DoD）", () => {
  async function realSourceRoot(): Promise<string> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return resolveSourceRoot(undefined, here);
  }

  it("init 直後の正常 repo は FAIL 無しで exit 0（中央 source schema での検証を含む）", async () => {
    const source = await realSourceRoot();
    await initGitRepo(repoRoot);

    const initCap: { out: string[]; err: string[] } = { out: [], err: [] };
    const initIo: InitIo = {
      stdout: (t) => initCap.out.push(t),
      stderr: (t) => initCap.err.push(t),
      color: false,
      now: () => NOW,
    };
    const initCode = await executeInit(
      { repo: repoRoot, distribution: "base", source, dryRun: false, json: false, verbose: false, color: false },
      initIo,
    );
    expect(initCode).toBe(0);

    const cap = captureIo();
    const code = await executeDoctor(options({ source }), cap.io);

    expect(code).toBe(DOCTOR_EXIT.ok);
    expect(cap.out()).toContain("project schema is valid using source schema");
    expect(cap.out()).toContain("managed file checksums are valid");
    expect(cap.out()).not.toContain("FAIL");
    // ai-improve は配布終了（計画 03 Stage 2-2）。新規 init 後の doctor に ai-improve 関連の出力は無い。
    expect(cap.out()).not.toContain("ai-improve");
    expect(cap.out()).toContain("Summary:");
  });
});
