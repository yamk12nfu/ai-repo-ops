/**
 * Phase 3 完了条件の検証（計画 v3 §18 Phase 3）。
 *
 *   1. manifest validation が通る            -> loadDistribution が成功する
 *   2. manifest 内の全 src が存在する          -> loadDistribution が成功する（src/template 不在なら SourceError）
 *   3. schema validation が通る               -> authoritative schema が valid で、
 *                                                project.yaml テンプレートがそれに適合する
 *
 * 加えて §0.2.5（authoritative schema と managed copy の二重編集禁止）を守るため、
 * managed copy が authoritative schema と一致していること（drift なし）も検証する。
 *
 * これらは実際の repo 上の distribution/base を対象に検証する（mock ではない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalizeTextString } from "../core/canonical-text.js";
import { loadDistribution } from "../core/source.js";
import { parseYaml } from "../core/yaml.js";

/** このテストファイルから repo root（packages/aro-cli/src/__tests__ -> 4 階層上）。 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const AUTHORITATIVE_SCHEMA = path.join(REPO_ROOT, "schemas", "project.schema.json");
const MANAGED_SCHEMA_COPY = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "schemas",
  "project.schema.json",
);
const AUTHORITATIVE_KNOWLEDGE_SCHEMA = path.join(REPO_ROOT, "schemas", "knowledge.schema.json");
const MANAGED_KNOWLEDGE_SCHEMA_COPY = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "schemas",
  "knowledge.schema.json",
);
const KNOWLEDGE_REFRESH_PROMPT = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "prompts",
  "knowledge-refresh.md",
);
const IMPROVE_PROMPT = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "prompts",
  "improve.md",
);
const ISSUE_FIX_PROMPT = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "prompts",
  "issue-fix.md",
);
const REVIEW_PROMPT = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".ai",
  "managed",
  "prompts",
  "review.md",
);
const TEMPLATE = path.join(REPO_ROOT, "distribution", "base", "project.yaml.hbs");
const DISTRIBUTED_REVIEW_WORKFLOW = path.join(
  REPO_ROOT,
  "distribution",
  "base",
  "files",
  ".github",
  "workflows",
  "ai-review.yml",
);
const REUSABLE_REVIEW_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ai-review.reusable.yml");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

// ---------------------------------------------------------------------------
// 最小 JSON Schema バリデータ（オフライン・依存追加なし）。
// 使用キーワード: type / const / enum / required / properties / items /
//                 additionalProperties / minLength / minimum のみ。
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** value を schema で検証し、違反を errors に push する。 */
function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  at: string,
  errors: string[],
): void {
  if ("const" in schema && !stableEqual(value, schema["const"])) {
    errors.push(`${at}: const ${JSON.stringify(schema["const"])} に一致しません`);
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => stableEqual(candidate, value))) {
    errors.push(`${at}: enum ${JSON.stringify(enumValues)} に含まれません (actual ${JSON.stringify(value)})`);
  }

  const typeKeyword = schema["type"];
  if (typeof typeKeyword === "string" || Array.isArray(typeKeyword)) {
    const types = Array.isArray(typeKeyword) ? typeKeyword : [typeKeyword];
    if (!types.some((type) => typeof type === "string" && matchesType(value, type))) {
      errors.push(`${at}: type ${JSON.stringify(typeKeyword)} に一致しません (actual ${typeName(value)})`);
      return; // type が違えば構造チェックは無意味なので打ち切る。
    }
  }

  const minLength = schema["minLength"];
  if (typeof value === "string" && typeof minLength === "number" && value.length < minLength) {
    errors.push(`${at}: minLength ${minLength} 未満`);
  }

  const minimum = schema["minimum"];
  if (typeof value === "number" && typeof minimum === "number" && value < minimum) {
    errors.push(`${at}: minimum ${minimum} 未満`);
  }

  if (isPlainObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in value)) {
          errors.push(`${at}: 必須プロパティ "${key}" がありません`);
        }
      }
    }
    const properties: Record<string, unknown> = isPlainObject(schema["properties"])
      ? schema["properties"]
      : {};
    const additional = schema["additionalProperties"];
    for (const [key, child] of Object.entries(value)) {
      const childAt = `${at}.${key}`;
      const propSchema = properties[key];
      if (isPlainObject(propSchema)) {
        validateAgainstSchema(child, propSchema, childAt, errors);
      } else if (additional === false) {
        errors.push(`${childAt}: 未知のプロパティ`);
      } else if (isPlainObject(additional)) {
        validateAgainstSchema(child, additional, childAt, errors);
      }
    }
  }

  const items = schema["items"];
  if (Array.isArray(value) && isPlainObject(items)) {
    value.forEach((item, index) => validateAgainstSchema(item, items, `${at}[${index}]`, errors));
  }
}

/** authoritative schema を読み込む。 */
async function readSchema(): Promise<Record<string, unknown>> {
  const raw = await readFile(AUTHORITATIVE_SCHEMA, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error("project.schema.json が object ではありません。");
  return parsed;
}

/** template の `{{ repo_name }}` を置換して YAML としてパースする（Phase 5 の render を待たない簡易版）。 */
async function renderTemplate(repoName: string): Promise<unknown> {
  const raw = await readFile(TEMPLATE, "utf8");
  const rendered = raw.replace(/\{\{\s*repo_name\s*\}\}/g, repoName);
  expect(rendered).not.toContain("{{"); // 未置換のプレースホルダが残っていないこと。
  return parseYaml(rendered);
}

describe("distribution/base（Phase 3 完了条件）", () => {
  it("manifest validation が通り、全 src が存在する（loadDistribution 成功）", async () => {
    const loaded = await loadDistribution(REPO_ROOT, "base");

    expect(loaded.manifest.name).toBe("base");
    expect(loaded.manifest.schema_version).toBe(1);

    // managed files: prompts 5件 + policies 3件 + schemas 2件。
    expect(loaded.managedFiles.map((file) => file.dest).sort()).toEqual(
      [
        ".ai/managed/policies/default.yaml",
        ".ai/managed/policies/low-risk.yaml",
        ".ai/managed/policies/security.yaml",
        ".ai/managed/prompts/improve.md",
        ".ai/managed/prompts/issue-fix.md",
        ".ai/managed/prompts/knowledge-refresh.md",
        ".ai/managed/prompts/release-check.md",
        ".ai/managed/prompts/review.md",
        ".ai/managed/schemas/knowledge.schema.json",
        ".ai/managed/schemas/project.schema.json",
      ].sort(),
    );
    // 各 managed file は中身があり、canonical sha256 を持つ。
    for (const file of loaded.managedFiles) {
      expect(file.content.length).toBeGreaterThan(0);
      expect(file.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // seed files: project.yaml（template）+ workflow stub 1 件（ai-improve は配布終了。計画 03 Stage 2-2）。
    expect(loaded.seedFiles.map((seed) => seed.dest).sort()).toEqual(
      [".ai/project.yaml", ".github/workflows/ai-review.yml"].sort(),
    );
    const projectSeed = loaded.seedFiles.find((seed) => seed.dest === ".ai/project.yaml");
    expect(projectSeed?.sourceKind).toBe("template");

    // patches: .gitignore / .gitattributes / .prettierignore。
    expect(loaded.patches.map((patch) => patch.path).sort()).toEqual(
      [".gitattributes", ".gitignore", ".prettierignore"].sort(),
    );

    // distribution content hash は 64 桁 hex。
    expect(loaded.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("managed schema copy が authoritative schema と一致する（§0.2.5: drift なし）", async () => {
    const [authoritative, managed] = await Promise.all([
      readFile(AUTHORITATIVE_SCHEMA, "utf8"),
      readFile(MANAGED_SCHEMA_COPY, "utf8"),
    ]);
    expect(canonicalizeTextString(managed)).toBe(canonicalizeTextString(authoritative));
  });

  it("managed knowledge schema copy が authoritative schema と一致する", async () => {
    const [authoritative, managed] = await Promise.all([
      readFile(AUTHORITATIVE_KNOWLEDGE_SCHEMA, "utf8"),
      readFile(MANAGED_KNOWLEDGE_SCHEMA_COPY, "utf8"),
    ]);
    expect(canonicalizeTextString(managed)).toBe(canonicalizeTextString(authoritative));
  });

  it("improve promptがprojectとpolicyのうち厳しい変更ファイル上限を案内する", async () => {
    const prompt = await readFile(IMPROVE_PROMPT, "utf8");

    expect(prompt).toContain(
      "`ai.max_changed_files` と適用 policy の `change_limits.max_changed_files`",
    );
    expect(prompt).toContain("小さい方");
  });

  it("issue fix promptがclean worktreeを開始条件にする", async () => {
    const prompt = await readFile(ISSUE_FIX_PROMPT, "utf8");

    expect(prompt).toContain("`git status --short`");
    expect(prompt).toContain("既存の未コミット変更がある場合");
  });

  it("issue fix promptがguardをquality gateとともに自己検証する", async () => {
    const prompt = await readFile(ISSUE_FIX_PROMPT, "utf8");

    expect(prompt).toContain("`aro guard --repo . --base origin/<default branch>`");
    expect(prompt).toContain("`quality_gates.required`");
  });

  it("issue fix promptがprojectとpolicyのfile・line上限を案内する", async () => {
    const prompt = await readFile(ISSUE_FIX_PROMPT, "utf8");

    expect(prompt).toContain(
      "`ai.max_changed_files` と適用 policy の `change_limits.max_changed_files`",
    );
    expect(prompt).toContain("小さい方");
    expect(prompt).toContain("`change_limits.max_added_lines`");
  });

  it("knowledge refresh promptが既存knowledgeだけを状態確認用に読み取り許可する", async () => {
    const prompt = await readFile(KNOWLEDGE_REFRESH_PROMPT, "utf8");

    expect(prompt).toContain(
      "既存Knowledgeの状態確認に限り、`.ai/local/knowledge/**` は読み取り専用で参照します",
    );
    expect(prompt).toContain("`.ai/**` の内容はknowledgeの根拠として使いません");
  });

  it("review promptがprojectとpolicyのforbidden pathを和集合で確認する", async () => {
    const prompt = await readFile(REVIEW_PROMPT, "utf8");

    expect(prompt).toContain(
      "`ai.forbidden_paths` と適用 policy の `forbidden_paths` の和集合",
    );
  });

  it("review promptがmanaged fileとlockfileの復旧を案内する", async () => {
    const prompt = await readFile(REVIEW_PROMPT, "utf8");

    expect(prompt).toContain("`.ai/ai-repo-ops.lock.yaml`");
    expect(prompt).toContain("`git restore -- .ai/managed/ .ai/ai-repo-ops.lock.yaml`");
    expect(prompt).toContain("`aro sync`");
  });

  it("knowledge refresh promptが安定した初回sourceとcommit後guardを案内する", async () => {
    const prompt = await readFile(KNOWLEDGE_REFRESH_PROMPT, "utf8");

    expect(prompt).toContain("初回entryでは変化しにくい正式文書を優先し");
    expect(prompt).toContain("個別タスク・作業ログ・日次生成物");
    expect(prompt).toContain("knowledge init` に使った同じlauncher");
    expect(prompt).toContain("knowledge init` の成功出力に完全な検証コマンドがある場合は、それを優先");
    expect(prompt).toContain("未commitの変更は `aro guard` の検証対象外");
    const checkIndex = prompt.indexOf("6. `aro knowledge check");
    const uncommittedIndex = prompt.indexOf("7. 未commitの変更");
    const guardIndex = prompt.indexOf("8. commit後に `aro guard");
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(uncommittedIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeLessThan(uncommittedIndex);
    expect(uncommittedIndex).toBeLessThan(guardIndex);
  });

  it("authoritative schema が valid な JSON Schema である", async () => {
    const schema = await readSchema();
    expect(schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema["type"]).toBe("object");
    expect(Array.isArray(schema["required"])).toBe(true);
    expect(isPlainObject(schema["properties"])).toBe(true);
  });

  it("project.yaml テンプレートが authoritative schema に適合する（schema validation 通過）", async () => {
    const schema = await readSchema();
    const rendered = await renderTemplate("sample-repo");

    const errors: string[] = [];
    validateAgainstSchema(rendered, schema, "(root)", errors);
    expect(errors).toEqual([]);

    // 念のため値も確認（schema_version=1, name 置換済み）。
    expect(isPlainObject(rendered)).toBe(true);
    if (isPlainObject(rendered)) {
      expect(rendered["schema_version"]).toBe(1);
      const project = rendered["project"];
      expect(isPlainObject(project) ? project["name"] : undefined).toBe("sample-repo");
      const ai = rendered["ai"];
      const allowedPaths = isPlainObject(ai) ? ai["allowed_paths"] : undefined;
      expect(Array.isArray(allowedPaths) ? allowedPaths : []).toContain(".ai/local/knowledge/**");
    }
  });

  it("knowledge MarkdownをLF管理するgitattributes patchを配布する", async () => {
    const loaded = await loadDistribution(REPO_ROOT, "base");
    const attributes = loaded.patches.find((patch) => patch.path === ".gitattributes");
    expect(attributes?.lines).toContain(".ai/local/knowledge/** text eol=lf");
  });

  it("配布するai-review workflowのpermissionsを必要最小限に限定する", async () => {
    const workflow = parseYaml(await readFile(DISTRIBUTED_REVIEW_WORKFLOW, "utf8"));

    expect(isPlainObject(workflow)).toBe(true);
    if (isPlainObject(workflow)) {
      expect(workflow["permissions"]).toEqual({
        contents: "read",
        "pull-requests": "write",
      });
    }
  });

  it("reusable workflowのaction runtimeと実行Node.jsを24へ移行する", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");

    expect([...workflow.matchAll(/uses: actions\/checkout@v5/g)]).toHaveLength(2);
    expect([...workflow.matchAll(/uses: actions\/setup-node@v5/g)]).toHaveLength(1);
    expect(workflow).not.toMatch(/uses: actions\/(?:checkout|setup-node)@v4/);
    expect(workflow).toContain("node-version: 24");
    expect(workflow).not.toContain("node-version: 20");
    expect(workflow).toContain("package-manager-cache: false");
  });

  it("reusable guardが同じworkflow commitのengine checkoutをauthoritative sourceに固定する", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");
    const start = workflow.indexOf("      - name: Run aro guard");
    const end = workflow.indexOf("      - name: Run knowledge check", start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(workflow).toContain("ref: ${{ job.workflow_sha");
    expect(workflow).not.toContain("job.workflow_sha ||");
    expect(workflow).not.toContain("job.workflow_repository ||");
    expect(step).toContain("--source .aro-engine");
  });

  it("reusable workflowのstep summaryにtrusted sync認証結果を表示する", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");
    const start = workflow.indexOf("      - name: Write step summary");
    const end = workflow.indexOf("      - name: Comment violations on PR", start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(step).toContain(".trustedSync.status");
    expect(step).toContain(".trustedSync.paths");
    expect(step).not.toContain(".trustedSync.trustedPaths");
    expect(step).toContain("Trusted sync");
  });

  it("中央CIのaction runtimeをNode.js 24へ移行し、Node.js 20/24互換テストは維持する", async () => {
    const workflow = await readFile(CI_WORKFLOW, "utf8");

    expect([...workflow.matchAll(/uses: actions\/checkout@v5/g)]).toHaveLength(2);
    expect([...workflow.matchAll(/uses: actions\/setup-node@v5/g)]).toHaveLength(2);
    expect([...workflow.matchAll(/package-manager-cache: false/g)]).toHaveLength(2);
    expect([...workflow.matchAll(/persist-credentials: false/g)]).toHaveLength(2);
    expect(workflow).not.toMatch(/uses: actions\/(?:checkout|setup-node)@v4/);
    expect(workflow).toContain('node-version: ["20", "24"]');
  });

  it("配布するai-review workflowがlegacy secretを現行guard未使用として説明する", async () => {
    const workflow = await readFile(DISTRIBUTED_REVIEW_WORKFLOW, "utf8");

    expect(workflow).toContain("現行 guard はこの secret を使用しない");
    expect(workflow).not.toContain("ANTHROPIC_API_KEY は対象 repo の Actions secrets に登録する");
    expect(workflow).not.toContain("未登録・fork PR の場合、AI レビューは明示的に skip");
  });

  it("reusable workflowがknowledge導入repoだけを検証し、knowledge変更PRではstrictにする", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");
    expect(workflow).toContain(".ai/local/knowledge/index.yaml");
    expect(workflow).toContain('git cat-file -e "origin/$BASE_REF:$INDEX_PATH"');
    expect(workflow).toContain("knowledge check");
    expect(workflow).toContain("--strict");
    expect(workflow).toContain("Fail on knowledge violations");
  });

  it("reusable workflowの生成物をcheckout外のRUNNER_TEMPへ隔離する", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");

    expect(workflow).toContain('id: artifacts');
    expect(workflow).toContain('mktemp -d "$RUNNER_TEMP/aro-review.XXXXXX"');
    expect(workflow).toContain('ARTIFACTS_DIR: ${{ steps.artifacts.outputs.dir }}');

    for (const artifact of [
      "guard-result.json",
      "guard-error.json",
      "guard-violations.md",
      "knowledge-result.json",
      "knowledge-error.json",
      "knowledge-findings.md",
      "guard-comment.md",
    ]) {
      expect(workflow).toContain(`"$ARTIFACTS_DIR/${artifact}"`);
      expect(workflow).not.toMatch(new RegExp(`(?<!/)${artifact.replace(".", "\\.")}`));
    }
  });

  it("knowledge結果JSONの変換失敗をexit 3としてfail-closedにする", async () => {
    const workflow = await readFile(REUSABLE_REVIEW_WORKFLOW, "utf8");
    const start = workflow.indexOf("      - name: Run knowledge check");
    const end = workflow.indexOf("      - name: Write step summary", start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(step).toContain("if ! jq -r '");
    expect(step).toContain('echo "knowledge checkのJSON結果を処理できませんでした。" >&2');
    expect(step).toContain('echo "exit_code=3" >> "$GITHUB_OUTPUT"');
    expect(step).toContain("exit 3");

    const unexpectedCodeOutput = step.indexOf('echo "exit_code=$code" >> "$GITHUB_OUTPUT"');
    const jsonConversion = step.indexOf("if ! jq -r '");
    const successfulCodeOutput = step.lastIndexOf('echo "exit_code=$code" >> "$GITHUB_OUTPUT"');
    expect(unexpectedCodeOutput).toBeGreaterThanOrEqual(0);
    expect(unexpectedCodeOutput).toBeLessThan(jsonConversion);
    expect(successfulCodeOutput).toBeGreaterThan(jsonConversion);
  });

  it("tarball smokeがknowledgeサブコマンドとHEAD設定境界を検証する", async () => {
    const workflow = await readFile(CI_WORKFLOW, "utf8");
    expect(workflow).toContain("aro knowledge --help");
    expect(workflow).toContain('git -C "$FIXTURE" commit');
    expect(workflow).toContain("aro knowledge init");
    expect(workflow).toContain("--base HEAD");
    expect(workflow).toContain("aro knowledge check");
    expect(workflow).toContain("--strict");
  });

  it("ミニバリデータが不正な project.yaml を検出する（バリデータ自体の健全性）", async () => {
    const schema = await readSchema();
    // risk_level が enum 外 / max_loops が 0（minimum 違反）/ 必須 commands 欠落。
    const broken = {
      schema_version: 1,
      project: { name: "x", type: "generic", risk_level: "extreme" },
      quality_gates: { required: ["test"] },
      ai: { max_loops: 0, max_changed_files: 10 },
    };
    const errors: string[] = [];
    validateAgainstSchema(broken, schema, "(root)", errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("risk_level");
  });
});
