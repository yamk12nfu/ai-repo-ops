import { describe, expect, it } from "vitest";

import { LOCKFILE_RELATIVE_PATH } from "../lockfile.js";
import { PROJECT_YAML_PATH } from "../manifest.js";
import { parsePolicyValue, type Policy } from "../policy.js";
import { parseProjectConfigValue, type ProjectConfig, type RiskLevel } from "../project-config.js";
import { runGuard, type GuardChangedFile } from "../guard.js";

/** テスト用 ProjectConfig を作る（project-config.ts の zod schema を通す）。 */
function projectConfig(
  input: {
    riskLevel?: RiskLevel;
    maxChangedFiles?: number;
    allowedPaths?: string[];
    forbiddenPaths?: string[];
  } = {},
): ProjectConfig {
  return parseProjectConfigValue({
    project: { name: "demo", type: "generic", risk_level: input.riskLevel ?? "medium" },
    ai: {
      ...(input.maxChangedFiles !== undefined ? { max_changed_files: input.maxChangedFiles } : {}),
      ...(input.allowedPaths !== undefined ? { allowed_paths: input.allowedPaths } : {}),
      ...(input.forbiddenPaths !== undefined ? { forbidden_paths: input.forbiddenPaths } : {}),
    },
  });
}

/** テスト用 Policy を作る（policy.ts の zod schema を通す）。 */
function policy(
  input: {
    maxChangedFiles?: number;
    maxAddedLines?: number;
    forbiddenPaths?: string[];
    severity?: Record<string, "fail" | "warn">;
  } = {},
): Policy {
  return parsePolicyValue({
    schema_version: 1,
    name: "test-policy",
    change_limits: {
      ...(input.maxChangedFiles !== undefined ? { max_changed_files: input.maxChangedFiles } : {}),
      ...(input.maxAddedLines !== undefined ? { max_added_lines: input.maxAddedLines } : {}),
    },
    ...(input.forbiddenPaths !== undefined ? { forbidden_paths: input.forbiddenPaths } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
  });
}

/** テスト用 changed file を作る。 */
function file(path: string, addedLines: number | null = 1, deletedLines: number | null = 0): GuardChangedFile {
  return { path, addedLines, deletedLines };
}

describe("runGuard: forbidden_paths", () => {
  it("project.yaml の ai.forbidden_paths に一致する path は forbidden_path 違反", () => {
    const report = runGuard({
      changedFiles: [file("secrets/token.txt")],
      projectConfig: projectConfig({ forbiddenPaths: ["secrets/**"] }),
      policy: policy(),
    });
    expect(report.hasViolations).toBe(true);
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "forbidden_path", path: "secrets/token.txt" }),
    ]);
  });

  it("policy の forbidden_paths に一致する path も forbidden_path 違反（project.yaml とマージして評価）", () => {
    const report = runGuard({
      changedFiles: [file("infra/prod/main.tf")],
      projectConfig: projectConfig(),
      policy: policy({ forbiddenPaths: ["infra/prod/**"] }),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "forbidden_path", path: "infra/prod/main.tf" }),
    ]);
  });

  it("forbidden_paths に一致しない path は違反にならない", () => {
    const report = runGuard({
      changedFiles: [file("src/index.ts")],
      projectConfig: projectConfig({ forbiddenPaths: ["secrets/**"] }),
      policy: policy({ forbiddenPaths: ["infra/prod/**"] }),
    });
    expect(report.hasViolations).toBe(false);
  });
});

describe("runGuard: managed files", () => {
  it(".ai/managed/** の変更は managed_file 違反", () => {
    const report = runGuard({
      changedFiles: [file(".ai/managed/policies/default.yaml")],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "managed_file", path: ".ai/managed/policies/default.yaml" }),
    ]);
  });

  it("lock file の変更は managed_file 違反", () => {
    const report = runGuard({
      changedFiles: [file(LOCKFILE_RELATIVE_PATH)],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "managed_file", path: LOCKFILE_RELATIVE_PATH }),
    ]);
  });

  it("trusted sync path は managed_file / outside_allowed_paths のみ免除する", () => {
    const trustedPath = ".ai/managed/prompts/review.md";
    const input = {
      changedFiles: [file(trustedPath)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
      trustedSyncPaths: new Set([trustedPath]),
    };

    const report = runGuard(input);

    expect(report.violations).toEqual([]);
  });

  it("trusted sync pathでもforbidden_pathは免除しない", () => {
    const trustedPath = ".ai/managed/prompts/review.md";
    const input = {
      changedFiles: [file(trustedPath)],
      projectConfig: projectConfig({
        allowedPaths: ["src/**"],
        forbiddenPaths: [".ai/managed/**"],
      }),
      policy: policy(),
      trustedSyncPaths: new Set([trustedPath]),
    };

    const report = runGuard(input);

    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "forbidden_path", path: trustedPath }),
    ]);
  });
});

describe("runGuard: workflows", () => {
  it(".github/workflows/** の変更は workflow 違反（policy の forbidden_paths に無くても既定で違反）", () => {
    const report = runGuard({
      changedFiles: [file(".github/workflows/ci.yml")],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "workflow", path: ".github/workflows/ci.yml" }),
    ]);
  });

  it("同一ファイルが forbidden_paths（policy）と既定の workflow ルールの両方に該当する場合、両方とも報告する", () => {
    const report = runGuard({
      changedFiles: [file(".github/workflows/ci.yml")],
      projectConfig: projectConfig(),
      policy: policy({ forbiddenPaths: [".github/workflows/**"] }),
    });
    const kinds = report.violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(["forbidden_path", "workflow"]);
    expect(report.summary.violationCount).toBe(2);
  });
});

describe("runGuard: project_config（.ai/project.yaml 自体の変更）", () => {
  it(".ai/project.yaml の変更は project_config 違反（設定に依らない既定の built-in）", () => {
    const report = runGuard({
      changedFiles: [file(PROJECT_YAML_PATH)],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "project_config", path: PROJECT_YAML_PATH }),
    ]);
  });

  it("project.yaml が allowed_paths に含まれず forbidden_paths にも一致する場合、project_config と他の kind が両方報告される", () => {
    const report = runGuard({
      changedFiles: [file(PROJECT_YAML_PATH)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"], forbiddenPaths: [PROJECT_YAML_PATH] }),
      policy: policy(),
    });
    const kinds = report.violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(["forbidden_path", "outside_allowed_paths", "project_config"]);
  });

  it("project.yaml 以外の .ai/** の変更は project_config 違反にならない", () => {
    const report = runGuard({
      changedFiles: [file(".ai/local/notes.md")],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations.filter((v) => v.kind === "project_config")).toEqual([]);
  });
});

describe("runGuard: allowed_paths", () => {
  it("allowed_paths が定義されている場合、いずれにも一致しない path は outside_allowed_paths 違反", () => {
    const report = runGuard({
      changedFiles: [file("docs/readme.md")],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "outside_allowed_paths", path: "docs/readme.md" }),
    ]);
  });

  it("allowed_paths に一致する path は違反にならない", () => {
    const report = runGuard({
      changedFiles: [file("src/index.ts")],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
    });
    expect(report.hasViolations).toBe(false);
  });

  it("allowed_paths が未定義なら outside_allowed_paths チェックはスキップされる（制限なし）", () => {
    const report = runGuard({
      changedFiles: [file("anywhere/whatever.txt")],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.hasViolations).toBe(false);
  });
});

describe("runGuard: change_limits（変更ファイル数）", () => {
  it("project.yaml より policy の max_changed_files が厳しい場合は policy の上限を使う", () => {
    const report = runGuard({
      changedFiles: Array.from({ length: 6 }, (_, i) => file(`file-${i}.ts`)),
      projectConfig: projectConfig({ maxChangedFiles: 10 }),
      policy: policy({ maxChangedFiles: 5 }),
    });

    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "too_many_files", limit: 5, actual: 6 }),
    ]);
  });

  it("policy より厳しい project.yaml の ai.max_changed_files を超えると too_many_files 違反", () => {
    const report = runGuard({
      changedFiles: [file("a.ts"), file("b.ts"), file("c.ts")],
      projectConfig: projectConfig({ maxChangedFiles: 2 }),
      policy: policy({ maxChangedFiles: 10 }),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "too_many_files", limit: 2, actual: 3 }),
    ]);
  });

  it("project.yaml に max_changed_files が無ければ policy の change_limits.max_changed_files を使う", () => {
    const report = runGuard({
      changedFiles: [file("a.ts"), file("b.ts"), file("c.ts")],
      projectConfig: projectConfig(),
      policy: policy({ maxChangedFiles: 2 }),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "too_many_files", limit: 2, actual: 3 }),
    ]);
  });

  it("max_changed_files が project.yaml/policy 両方とも未定義なら制限なし", () => {
    const report = runGuard({
      changedFiles: Array.from({ length: 100 }, (_, i) => file(`file-${i}.ts`)),
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations.filter((v) => v.kind === "too_many_files")).toEqual([]);
  });

  it("変更ファイル数が上限ちょうどなら違反にならない", () => {
    const report = runGuard({
      changedFiles: [file("a.ts"), file("b.ts")],
      projectConfig: projectConfig({ maxChangedFiles: 2 }),
      policy: policy(),
    });
    expect(report.violations.filter((v) => v.kind === "too_many_files")).toEqual([]);
  });
});

describe("runGuard: change_limits（追加行数）", () => {
  it("追加行数合計が policy の max_added_lines を超えると too_many_added_lines 違反", () => {
    const report = runGuard({
      changedFiles: [file("a.ts", 10), file("b.ts", 5)],
      projectConfig: projectConfig(),
      policy: policy({ maxAddedLines: 12 }),
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "too_many_added_lines", limit: 12, actual: 15 }),
    ]);
  });

  it("バイナリファイル（addedLines=null）は追加行数 0 として扱われる", () => {
    const report = runGuard({
      changedFiles: [file("a.ts", 10), file("logo.png", null, null)],
      projectConfig: projectConfig(),
      policy: policy({ maxAddedLines: 10 }),
    });
    expect(report.summary.addedLines).toBe(10);
    expect(report.violations.filter((v) => v.kind === "too_many_added_lines")).toEqual([]);
  });

  it("max_added_lines が未定義なら制限なし", () => {
    const report = runGuard({
      changedFiles: [file("a.ts", 10_000)],
      projectConfig: projectConfig(),
      policy: policy(),
    });
    expect(report.violations).toEqual([]);
  });
});

describe("runGuard: summary / hasViolations", () => {
  it("違反が無ければ hasViolations は false、summary は checkedFiles/addedLines/violationCount を正しく返す", () => {
    const report = runGuard({
      changedFiles: [file("src/a.ts", 3), file("src/b.ts", 2, 1), file("bin.png", null, null)],
      projectConfig: projectConfig({ allowedPaths: ["src/**", "*.png"] }),
      policy: policy(),
    });
    expect(report.hasViolations).toBe(false);
    expect(report.hasFailures).toBe(false);
    expect(report.summary).toEqual({
      checkedFiles: 3,
      addedLines: 5,
      violationCount: 0,
      failCount: 0,
      warnCount: 0,
    });
  });

  it("削除されたファイル（addedLines=0）も checkedFiles にはカウントされる", () => {
    const report = runGuard({
      changedFiles: [file("src/removed.ts", 0, 20)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
    });
    expect(report.summary.checkedFiles).toBe(1);
    expect(report.summary.addedLines).toBe(0);
  });
});

describe("runGuard: severity", () => {
  const AI_SCOPE_WARN = {
    outside_allowed_paths: "warn",
    too_many_files: "warn",
    forbidden_path: "fail",
  } as const;

  it("severity 未指定の policy では全 violation が fail（後方互換）", () => {
    const report = runGuard({
      changedFiles: [file("outside/a.ts", 1)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
    });
    expect(report.violations.map((v) => v.severity)).toEqual(["fail"]);
    expect(report.hasFailures).toBe(true);
  });

  it("warn 指定の violation だけなら hasFailures は false（報告は残る）", () => {
    const report = runGuard({
      changedFiles: [file("outside/a.ts", 1), file("outside/b.ts", 1)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy({ maxChangedFiles: 1, severity: AI_SCOPE_WARN }),
    });

    // outside_allowed_paths × 2 + too_many_files × 1 がすべて warn として残る。
    expect(report.violations).toHaveLength(3);
    expect(report.violations.every((v) => v.severity === "warn")).toBe(true);
    expect(report.hasViolations).toBe(true);
    expect(report.hasFailures).toBe(false);
    expect(report.summary.warnCount).toBe(3);
    expect(report.summary.failCount).toBe(0);
  });

  it("fail 指定の violation が 1 件でもあれば hasFailures は true", () => {
    const report = runGuard({
      changedFiles: [file("outside/a.ts", 1), file(".env", 1)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"], forbiddenPaths: [".env"] }),
      policy: policy({ severity: AI_SCOPE_WARN }),
    });

    const forbidden = report.violations.filter((v) => v.kind === "forbidden_path");
    expect(forbidden.map((v) => v.severity)).toEqual(["fail"]);
    expect(report.hasFailures).toBe(true);
    expect(report.summary.failCount).toBe(1);
  });

  it("表に無い kind は fail 扱いになる（緩める側を既定にしない）", () => {
    const report = runGuard({
      changedFiles: [file(PROJECT_YAML_PATH, 1)],
      projectConfig: projectConfig({ allowedPaths: [".ai/**"] }),
      policy: policy({ severity: { outside_allowed_paths: "warn" } }),
    });

    const projectConfigViolation = report.violations.find((v) => v.kind === "project_config");
    expect(projectConfigViolation?.severity).toBe("fail");
    expect(report.hasFailures).toBe(true);
  });
});

describe("runGuard: proposal_decision", () => {
  const PROPOSAL_PATH = ".ai/local/proposals/2026-08-sample.md";

  it("違反になる遷移は proposal_decision violation として報告される（既定 severity は fail）", () => {
    const report = runGuard({
      changedFiles: [file(PROPOSAL_PATH)],
      projectConfig: projectConfig({ allowedPaths: [".ai/local/proposals/**"] }),
      policy: policy(),
      proposalTransitions: [
        {
          path: PROPOSAL_PATH,
          base: { kind: "proposal", status: "open" },
          head: { kind: "proposal", status: "accepted" },
        },
      ],
    });

    expect(report.violations).toEqual([
      expect.objectContaining({
        kind: "proposal_decision",
        path: PROPOSAL_PATH,
        severity: "fail",
      }),
    ]);
    expect(report.hasFailures).toBe(true);
  });

  it("正常な遷移（なし → open）は違反にならない", () => {
    const report = runGuard({
      changedFiles: [file(PROPOSAL_PATH)],
      projectConfig: projectConfig({ allowedPaths: [".ai/local/proposals/**"] }),
      policy: policy(),
      proposalTransitions: [
        { path: PROPOSAL_PATH, base: { kind: "absent" }, head: { kind: "proposal", status: "open" } },
      ],
    });

    expect(report.violations).toEqual([]);
    expect(report.hasFailures).toBe(false);
  });

  it("policy の severity 表で warn を指定しても、遷移の違反は報告される（severity は表に従う）", () => {
    const report = runGuard({
      changedFiles: [file(PROPOSAL_PATH)],
      projectConfig: projectConfig({ allowedPaths: [".ai/local/proposals/**"] }),
      policy: policy({ severity: { proposal_decision: "warn" } }),
      proposalTransitions: [
        {
          path: PROPOSAL_PATH,
          base: { kind: "proposal", status: "open" },
          head: { kind: "proposal", status: "rejected" },
        },
      ],
    });

    expect(report.violations).toEqual([
      expect.objectContaining({ kind: "proposal_decision", severity: "warn" }),
    ]);
    expect(report.hasFailures).toBe(false);
  });

  it("proposalTransitions 未指定なら proposal_decision は判定しない", () => {
    const report = runGuard({
      changedFiles: [file(PROPOSAL_PATH)],
      projectConfig: projectConfig({ allowedPaths: [".ai/local/proposals/**"] }),
      policy: policy(),
    });

    expect(report.violations).toEqual([]);
  });

  it("allowed_paths 外の proposal 遷移は outside_allowed_paths と proposal_decision の両方を報告する", () => {
    const report = runGuard({
      changedFiles: [file(PROPOSAL_PATH)],
      projectConfig: projectConfig({ allowedPaths: ["src/**"] }),
      policy: policy(),
      proposalTransitions: [
        {
          path: PROPOSAL_PATH,
          base: { kind: "proposal", status: "open" },
          head: { kind: "absent" },
        },
      ],
    });

    expect(report.violations).toHaveLength(2);
    expect(report.violations.map((v) => v.kind).sort()).toEqual([
      "outside_allowed_paths",
      "proposal_decision",
    ]);
  });
});
