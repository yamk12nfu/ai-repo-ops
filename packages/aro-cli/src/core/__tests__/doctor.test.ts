import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDoctor, type DoctorCheck, type DoctorReport } from "../doctor.js";
import { LOCKFILE_RELATIVE_PATH } from "../lockfile.js";
import { loadDistribution } from "../source.js";
import {
  initGitRepo,
  makeTempDir,
  seedRepoAsSynced,
  setupBaseDistribution,
  writeRaw,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-doctor-core-src-");
  repoRoot = await makeTempDir("aro-doctor-core-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

/** テストで使う JSON Schema（`schemas/project.schema.json` の構造を模した最小版）。 */
const PROJECT_SCHEMA = {
  type: "object",
  required: ["schema_version", "project", "commands", "quality_gates"],
  properties: {
    schema_version: { const: 1 },
    project: {
      type: "object",
      required: ["name", "risk_level"],
      properties: {
        name: { type: "string", minLength: 1 },
        risk_level: { type: "string", enum: ["low", "medium", "high"] },
      },
    },
    commands: { type: "object", additionalProperties: { type: "string" } },
    quality_gates: {
      type: "object",
      properties: { required: { type: "array", items: { type: "string" } } },
    },
  },
};

const VALID_PROJECT_YAML = `schema_version: 1
project:
  name: demo
  risk_level: medium
commands:
  lint: "eslint ."
  test: ""
quality_gates:
  required:
    - lint
    - test
`;

function findCheck(report: DoctorReport, id: string): DoctorCheck | undefined {
  return report.checks.find((c) => c.id === id);
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await stat(path.join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

describe("runDoctor: Repository", () => {
  it("Git repo でなければ git.repo は FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    // initGitRepo を呼ばない。
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "git.repo")?.status).toBe("fail");
    expect(report.hasFailures).toBe(true);
  });

  it("Git repo なら git.repo は PASS", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "git.repo")?.status).toBe("pass");
  });
});

describe("runDoctor: project.yaml / schema 検証", () => {
  it("project.yaml が無ければ FAIL、schema チェックはスキップされる", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "project-yaml.exists")?.status).toBe("fail");
    expect(findCheck(report, "project-yaml.schema")).toBeUndefined();
  });

  it("schema に適合すれば project-yaml.schema は PASS", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(repoRoot, ".ai/project.yaml", VALID_PROJECT_YAML);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "project-yaml.schema");
    expect(check?.status).toBe("pass");
    expect(check?.message).toBe("project schema is valid using source schema");
  });

  it("risk_level が enum 外なら project-yaml.schema は FAIL（中央 source schema で検証）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".ai/project.yaml",
      VALID_PROJECT_YAML.replace("risk_level: medium", "risk_level: extreme"),
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "project-yaml.schema")?.status).toBe("fail");
  });

  it("壊れた YAML は project-yaml.schema を FAIL にする", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(repoRoot, ".ai/project.yaml", "key: [unterminated\n");
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "project-yaml.schema")?.status).toBe("fail");
  });
});

describe("runDoctor: commands / quality_gates（§12 / §17.4 Commands）", () => {
  it("quality_gates.required にあるが commands に無いキーは FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".ai/project.yaml",
      `schema_version: 1
project:
  name: demo
  risk_level: medium
commands:
  lint: "eslint ."
quality_gates:
  required:
    - lint
    - typecheck
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "commands.quality-gate-missing.typecheck");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe(
      'required command "typecheck" is listed in quality_gates but missing in commands',
    );
  });

  it("空文字 command は WARN（FAIL にはしない）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(repoRoot, ".ai/project.yaml", VALID_PROJECT_YAML);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "commands.empty.test");
    expect(check?.status).toBe("warn");
  });
});

describe("runDoctor: lock file", () => {
  it("lock が無ければ FAIL、managed checksum チェックはスキップされる", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "lock.exists")?.status).toBe("fail");
    expect(findCheck(report, "managed.checksums")).toBeUndefined();
  });

  it("壊れた lock file は lock.schema を FAIL にする（手編集からの復旧ヒント付き）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(repoRoot, LOCKFILE_RELATIVE_PATH, "not_a_valid_lock: true\n");
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "lock.schema");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toBeDefined();
  });
});

describe("runDoctor: managed file checksum（Scenario 3 / 7）", () => {
  it("人間が managed file を編集すると checksum mismatch で FAIL、git restore のヒントを持つ", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);
    await writeRaw(repoRoot, ".ai/managed/prompts/review.md", "# Review prompt\nLOCAL EDIT\n");

    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "managed.checksum-mismatch..ai/managed/prompts/review.md");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toContain("git restore");
    expect(check?.hint).toContain(".ai/managed/prompts/review.md");
  });

  it("同期済みなら managed.checksums は PASS", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });
    expect(findCheck(report, "managed.checksums")?.status).toBe("pass");
  });
});

describe("runDoctor: orphaned managed file（Scenario 9・§16.4）", () => {
  it("source manifest から消えた managed file は WARN・削除されない", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist1);

    // policies/default.yaml を含まない manifest へ差し替える(review.md のみ管理対象にする)。
    await writeRaw(
      sourceRoot,
      "distribution/base/manifest.yaml",
      `schema_version: 1
name: base
version: 0.2.0
files:
  - src: files/.ai/managed/prompts/review.md
    dest: .ai/managed/prompts/review.md
    strategy: managed_overwrite
seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only
  - src: files/.github/workflows/ai-review.yml
    dest: .github/workflows/ai-review.yml
    strategy: create_only
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
      - .ai/logs/
  - type: append_unique_lines
    path: .gitattributes
    lines:
      - "# ai-repo-ops managed text files"
      - ".ai/managed/** text eol=lf"
preserve:
  - .ai/project.yaml
  - .ai/local/**
`,
    );
    const dist2 = await loadDistribution(sourceRoot, "base");

    const report = await runDoctor({ repoRoot, distribution: dist2, projectSchema: PROJECT_SCHEMA });

    const orphan = findCheck(report, "managed.orphaned..ai/managed/policies/default.yaml");
    expect(orphan?.status).toBe("warn");
    expect(orphan?.hint).toContain("not deleted");
    // MVP では自動削除しない。
    expect(await exists(".ai/managed/policies/default.yaml")).toBe(true);
  });
});

describe("runDoctor: append_unique_lines patch（.gitignore / .gitattributes / .prettierignore）", () => {
  it("必要行が揃っていれば PASS、欠けていれば WARN", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist, { applyPatches: false });

    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });
    const gitignore = findCheck(report, "patch..gitignore");
    expect(gitignore?.status).toBe("warn");
    expect(gitignore?.message).toContain(".ai/runs/");
  });

  it("sync 済みなら patch チェックは PASS", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist, { applyPatches: true });

    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });
    expect(findCheck(report, "patch..gitignore")?.status).toBe("pass");
    expect(findCheck(report, "patch..gitattributes")?.status).toBe("pass");
  });
});

describe("runDoctor: GitHub Actions workflow", () => {
  it("workflow が無ければ FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.exists")?.status).toBe("fail");
    expect(findCheck(report, "workflow.ai-improve.exists")?.status).toBe("fail");
  });

  it("reusable workflow を呼んでいなければ FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    runs-on: ubuntu-latest
    steps:
      - run: echo no-op
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.reusable-call")?.status).toBe("fail");
  });

  it("同名ファイルでも別 org/repo の reusable workflow を指していれば FAIL（ファイル名の部分一致だけで PASS にしない）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: some-other-org/some-other-repo/.github/workflows/ai-review.reusable.yml@v1
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "workflow.ai-review.reusable-call");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml");
  });

  it("正しい path でも @ref が無ければ FAIL（GitHub Actions は他リポジトリ呼び出しに @ref を必須とする）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "workflow.ai-review.reusable-call");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("without a version ref");
  });

  it("@ref が空文字（末尾が @ のみ）でも FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
jobs:
  ai_review:
    uses: "yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@"
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.reusable-call")?.status).toBe("fail");
  });

  it("@main 参照は WARN", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@main
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.ref")?.status).toBe("warn");
  });

  it("中央 workflow 自身がタグ固定されていれば、無関係な別 job の @main 参照では WARN しない", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
  unrelated:
    uses: some-other-org/some-other-repo/.github/workflows/other.yml@main
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.reusable-call")?.status).toBe("pass");
    expect(findCheck(report, "workflow.ai-review.ref")).toBeUndefined();
  });

  it("ai-review workflow の contents:write は FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: write
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.permissions")?.status).toBe("fail");
  });

  it("ai-improve workflow の contents:write は WARN（改善モードのため許容・branch protection の注意喚起）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-improve.yml",
      `name: AI Improve
on:
  workflow_dispatch: {}
permissions:
  contents: write
  pull-requests: write
jobs:
  ai_improve:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-improve.reusable.yml@v1
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    const check = findCheck(report, "workflow.ai-improve.permissions");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("branch protection");
  });

  it("permissions: write-all（scalar shorthand）も contents:write 相当として検出する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions: write-all
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.permissions")?.status).toBe("fail");
  });

  it("job 単位の permissions（contents: write）も top-level が read でも検出する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
    permissions:
      contents: write
`,
    );
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.permissions")?.status).toBe("fail");
  });

  it("workflow YAML が壊れていれば parse チェックが FAIL", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await writeRaw(repoRoot, ".github/workflows/ai-review.yml", "key: [unterminated\n");
    const dist = await loadDistribution(sourceRoot, "base");
    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });

    expect(findCheck(report, "workflow.ai-review.parse")?.status).toBe("fail");
  });
});

describe("runDoctor: summary / hasFailures", () => {
  it("FAIL が無ければ hasFailures は false", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);
    await writeRaw(repoRoot, ".ai/project.yaml", VALID_PROJECT_YAML);
    // fixture の既定 ai-review.yml stub には jobs が無いため、reusable-call チェックを PASS させるため上書きする。
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-review.yml",
      `name: AI Review
on:
  pull_request: {}
permissions:
  contents: read
jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
`,
    );
    await writeRaw(
      repoRoot,
      ".github/workflows/ai-improve.yml",
      `name: AI Improve
on:
  workflow_dispatch: {}
permissions:
  contents: write
jobs:
  ai_improve:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-improve.reusable.yml@v1
`,
    );

    const report = await runDoctor({ repoRoot, distribution: dist, projectSchema: PROJECT_SCHEMA });
    expect(report.summary.failed).toBe(0);
    expect(report.hasFailures).toBe(false);
    // ai-improve の contents:write と test コマンド空文字で WARN が出る。
    expect(report.summary.warned).toBeGreaterThan(0);
  });
});
