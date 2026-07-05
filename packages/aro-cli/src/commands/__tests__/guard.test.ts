import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeGuard, GUARD_EXIT, type GuardIo, type GuardOptions } from "../guard.js";
import { executeInit, type InitIo } from "../init.js";
import { resolveSourceRoot } from "../../core/source.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import { gitCheckoutNewBranch, gitCommitAll, initRealGitRepo } from "../../test-support/git.fixture.js";

let repoRoot: string;

const NOW = "2026-07-01T12:00:00.000Z";

/** guard 単体テスト用の project.yaml（risk_level: medium → policies/default.yaml が適用される）。 */
const PROJECT_YAML = `schema_version: 1
project:
  name: demo
  type: generic
  risk_level: medium
commands:
  lint: ""
quality_gates:
  required: []
ai:
  max_changed_files: 3
  allowed_paths:
    - "src/**"
review:
  require_human_review: true
evals: {}
`;

/** guard 単体テスト用の policy（.ai/managed/policies/default.yaml。medium risk_level に対応）。 */
const POLICY_DEFAULT = `schema_version: 1
name: default
change_limits:
  max_changed_files: 10
  max_added_lines: 5
forbidden_paths:
  - "secrets/**"
`;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-guard-cmd-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<GuardOptions> = {}): GuardOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    base: "main",
    ...overrides,
  };
}

function captureIo(): { io: GuardIo; out: () => string; err: () => string } {
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

/**
 * project.yaml / policy を配置して base（main）に commit する。
 *
 * guard は project.yaml / policy を PR HEAD ではなく merge-base から読むため（自己改変・迂回防止。
 * commands/guard.ts 冒頭コメント参照）、これらは必ず `main` 側で commit してから `feature` に
 * branch する必要がある。branch 後に main を進めない限り、merge-base(main, feature) はこの commit
 * そのものになる。
 */
async function setupProjectAndPolicy(): Promise<void> {
  await writeRaw(repoRoot, ".ai/project.yaml", PROJECT_YAML);
  await writeRaw(repoRoot, ".ai/managed/policies/default.yaml", POLICY_DEFAULT);
  await gitCommitAll(repoRoot, "chore: init project config and policy");
}

describe("executeGuard: 違反なし", () => {
  it("allowed_paths 内・上限内の変更のみなら exit 0、human 出力は OK", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "src/index.ts", "export const x = 1;\n");
    await gitCommitAll(repoRoot, "feat: add index");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main" }), cap.io);
    expect(code).toBe(GUARD_EXIT.ok);
    expect(cap.out()).toContain("no policy violations");
    expect(cap.out()).toContain("Summary:");
  });
});

describe("executeGuard: 違反あり", () => {
  it("allowed_paths 外への変更は exit 1、human 出力に違反が出る", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "docs/readme.md", "# doc\n");
    await gitCommitAll(repoRoot, "docs: add readme");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main" }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);
    expect(cap.out()).toContain("VIOLATION");
    expect(cap.out()).toContain("outside_allowed_paths");
    expect(cap.out()).toContain("docs/readme.md");
  });

  it("policy の forbidden_paths（secrets/**）への変更は exit 1", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    // allowed_paths (src/**) と forbidden_paths (secrets/**) 両方に該当しない場所なので
    // outside_allowed_paths と forbidden_path の 2 件になる。
    await writeRaw(repoRoot, "secrets/token.txt", "sh-hh\n");
    await gitCommitAll(repoRoot, "chore: add secret (should be blocked)");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main" }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);
    expect(cap.out()).toContain("forbidden_path");
  });

  it("非 ASCII path も forbidden_paths 判定にかかる（git core.quotePath による誤判定の回帰防止）", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    // git は既定で非 ASCII path を numstat 上 C-style quote するため、core/git-diff.ts が -z を
    // 使わずに path を素の tab 区切りで返すと、picomatch の forbidden_paths (secrets/**) 判定が
    // クォート済み文字列に対して行われ、この違反を見逃す（回帰防止）。
    await writeRaw(repoRoot, "secrets/日本語.txt", "shh\n");
    await gitCommitAll(repoRoot, "chore: 日本語ファイル名のsecretを追加（should be blocked）");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);

    const parsed = JSON.parse(cap.out()) as {
      report: { violations: Array<{ kind: string; path?: string }> };
    };
    expect(
      parsed.report.violations.some((v) => v.kind === "forbidden_path" && v.path === "secrets/日本語.txt"),
    ).toBe(true);
  });
});

describe("executeGuard: project_config built-in violation", () => {
  it(".ai/project.yaml のみ変更した PR は project_config violation で exit 1", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    // guard は project.yaml を base（merge-base）から読むため、この変更内容自体は判定に使われない
    // （risk_level を書き換えても無視される）。変更されたという事実だけが built-in violation になる。
    await writeRaw(repoRoot, ".ai/project.yaml", PROJECT_YAML.replace("risk_level: medium", "risk_level: low"));
    await gitCommitAll(repoRoot, "chore: tweak risk_level in project.yaml");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);

    const parsed = JSON.parse(cap.out()) as {
      report: { violations: Array<{ kind: string; path?: string }> };
    };
    expect(
      parsed.report.violations.some((v) => v.kind === "project_config" && v.path === ".ai/project.yaml"),
    ).toBe(true);
  });
});

describe("executeGuard: 自己改変・迂回の回帰防止（self-modification bypass）", () => {
  it("PR が project.yaml/policy 相当の制約を緩めても、base（merge-base）側の厳しい設定で判定される", async () => {
    // base: forbidden_paths に infra/prod/** を含む厳しい project.yaml + policy を置く。
    const strictProjectYaml = `schema_version: 1
project:
  name: demo
  type: generic
  risk_level: medium
ai:
  forbidden_paths:
    - "infra/prod/**"
`;
    await writeRaw(repoRoot, ".ai/project.yaml", strictProjectYaml);
    await writeRaw(repoRoot, ".ai/managed/policies/default.yaml", POLICY_DEFAULT);
    await gitCommitAll(repoRoot, "chore: strict base config (forbids infra/prod/**)");

    await gitCheckoutNewBranch(repoRoot, "feature");

    // (a) PR 内で project.yaml を緩める（risk_level を down、forbidden_paths を空・allowed_paths を全許可に）。
    const loosenedProjectYaml = `schema_version: 1
project:
  name: demo
  type: generic
  risk_level: low
ai:
  forbidden_paths: []
  allowed_paths:
    - "**"
`;
    await writeRaw(repoRoot, ".ai/project.yaml", loosenedProjectYaml);
    await gitCommitAll(repoRoot, "chore: self-modify project.yaml to bypass guard (attack)");

    // (b) forbidden path（infra/prod/**）への変更。
    await writeRaw(repoRoot, "infra/prod/config.txt", "malicious change\n");
    await gitCommitAll(repoRoot, "chore: change infra/prod config (should be blocked by base config)");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);

    const parsed = JSON.parse(cap.out()) as {
      report: { violations: Array<{ kind: string; path?: string }> };
    };
    // base の forbidden_paths（infra/prod/**）で判定される。PR 内で forbidden_paths を空にしても
    // 無視される（= working tree の project.yaml を読んでいたら通ってしまっていたはずの変更が阻止される）。
    expect(
      parsed.report.violations.some((v) => v.kind === "forbidden_path" && v.path === "infra/prod/config.txt"),
    ).toBe(true);
    // project.yaml 自体の変更も built-in violation として必ず報告される（人間レビューを促す）。
    expect(
      parsed.report.violations.some((v) => v.kind === "project_config" && v.path === ".ai/project.yaml"),
    ).toBe(true);
  });
});

describe("executeGuard: --json", () => {
  it("違反なしの JSON 構造", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "src/index.ts", "export const x = 1;\n");
    await gitCommitAll(repoRoot, "feat: add index");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.ok);

    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      base: string;
      report: { violations: unknown[]; hasViolations: boolean; summary: { checkedFiles: number } };
    };
    expect(parsed.command).toBe("guard");
    expect(parsed.ok).toBe(true);
    expect(parsed.base).toBe("main");
    expect(parsed.report.hasViolations).toBe(false);
    expect(parsed.report.violations).toEqual([]);
    expect(parsed.report.summary.checkedFiles).toBe(1);
  });

  it("違反ありの JSON 構造", async () => {
    await setupProjectAndPolicy();
    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "docs/readme.md", "# doc\n");
    await gitCommitAll(repoRoot, "docs: add readme");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);

    const parsed = JSON.parse(cap.out()) as {
      ok: boolean;
      report: { violations: Array<{ kind: string; path?: string }> };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.report.violations.some((v) => v.kind === "outside_allowed_paths")).toBe(true);
  });

  it("unexpected error の JSON 構造（base に project.yaml が無い）", async () => {
    // base（main）に project.yaml を置かないコミットだけ作る。merge-base の解決自体は成功するが、
    // project.yaml が無いことを判定できることを確認する。
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial commit without project.yaml");

    const cap = captureIo();
    const code = await executeGuard(options({ json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.unexpected);

    const parsed = JSON.parse(cap.err()) as { command: string; ok: boolean; error: { code: string } };
    expect(parsed.command).toBe("guard");
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("PROJECT_CONFIG_NOT_FOUND");
  });
});

describe("executeGuard: unexpected（exit 3）", () => {
  it("base に project.yaml が無ければ exit 3（導入 PR を案内する hint 付き）", async () => {
    // main に project.yaml を含まないコミットを作るだけ（merge-base は解決できるが project.yaml が無い）。
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial commit without project.yaml");

    const cap = captureIo();
    const code = await executeGuard(options(), cap.io);
    expect(code).toBe(GUARD_EXIT.unexpected);
    expect(cap.err()).toContain("ERROR");
    expect(cap.err()).toContain("導入 PR");
  });

  it("base に project.yaml はあるが policy ファイルが無ければ exit 3", async () => {
    await writeRaw(repoRoot, ".ai/project.yaml", PROJECT_YAML);
    await gitCommitAll(repoRoot, "chore: add project.yaml only");

    const cap = captureIo();
    const code = await executeGuard(options(), cap.io);
    expect(code).toBe(GUARD_EXIT.unexpected);
    expect(cap.err()).toContain("ERROR");
  });

  it("Git repo でなければ exit 3", async () => {
    const nonGitRoot = await makeTempDir("aro-guard-nongit-");
    try {
      const cap = captureIo();
      const code = await executeGuard(options({ repo: nonGitRoot }), cap.io);
      expect(code).toBe(GUARD_EXIT.unexpected);
    } finally {
      await rm(nonGitRoot, { recursive: true, force: true });
    }
  });

  it("merge-base の解決に失敗する（bad base ref）なら exit 3", async () => {
    await setupProjectAndPolicy();
    const cap = captureIo();
    const code = await executeGuard(options({ base: "does-not-exist-ref", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.unexpected);

    const parsed = JSON.parse(cap.err()) as { error: { code: string } };
    expect(parsed.error.code).toBe("GIT_MERGE_BASE_FAILED");
  });
});

describe("executeGuard: 実 distribution/base に対するエンドツーエンド", () => {
  async function realSourceRoot(): Promise<string> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return resolveSourceRoot(undefined, here);
  }

  it("aro init が生成する実 project.yaml / policy を guard がそのまま読める", async () => {
    const source = await realSourceRoot();

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
    await gitCommitAll(repoRoot, "chore: aro init");

    await gitCheckoutNewBranch(repoRoot, "feature");
    await writeRaw(repoRoot, "src/index.ts", "export const x = 1;\n");
    await gitCommitAll(repoRoot, "feat: add index");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main" }), cap.io);
    // 実 project.yaml は risk_level: medium → policies/default.yaml（forbidden_paths に
    // .github/workflows/** 等・change_limits.max_changed_files: 10）が適用される。1 ファイルの
    // 追加だけなら違反なし。project.yaml / policy は main（= merge-base）から commit 済みなので
    // 読み込める。
    expect(code).toBe(GUARD_EXIT.ok);
  });

  it("実 policy の forbidden_paths（.github/workflows/**）への変更は workflow・forbidden_path・outside_allowed_paths の 3 件の違反", async () => {
    const source = await realSourceRoot();
    const initIo: InitIo = {
      stdout: () => {},
      stderr: () => {},
      color: false,
      now: () => NOW,
    };
    const initCode = await executeInit(
      { repo: repoRoot, distribution: "base", source, dryRun: false, json: false, verbose: false, color: false },
      initIo,
    );
    expect(initCode).toBe(0);
    await gitCommitAll(repoRoot, "chore: aro init");

    await gitCheckoutNewBranch(repoRoot, "feature");
    // ai-review.yml は seed（create_only）なので既に存在する。内容を書き換えて diff を作る。
    await writeRaw(repoRoot, ".github/workflows/ai-review.yml", "name: AI Review (tampered)\n");
    await gitCommitAll(repoRoot, "chore: tamper workflow");

    const cap = captureIo();
    const code = await executeGuard(options({ base: "main", json: true }), cap.io);
    expect(code).toBe(GUARD_EXIT.violations);

    const parsed = JSON.parse(cap.out()) as {
      report: { violations: Array<{ kind: string }> };
    };
    // .github/workflows/** は既定の workflow ルールに加え、実 project.yaml.hbs の
    // ai.forbidden_paths にも列挙されている（forbidden_path）。さらに実 project.yaml.hbs の
    // ai.allowed_paths（src/**・tests/**・docs/**）のいずれにも一致しないため
    // outside_allowed_paths も発生し、合計 3 件になる。
    expect(parsed.report.violations.map((v) => v.kind).sort()).toEqual([
      "forbidden_path",
      "outside_allowed_paths",
      "workflow",
    ]);
  });
});
