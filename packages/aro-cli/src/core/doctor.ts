/**
 * `aro doctor` の診断エンジン（計画 v3 §17.4）。
 *
 * 対象 repo が ai-repo-ops に正しく参加できているかを PASS / WARN / FAIL のチェック列として判定する。
 * 読み取り専用（実ファイルは一切書き換えない）。
 *
 * 設計方針: managed file の checksum 不一致・orphaned managed file・`.gitignore` /
 * `.gitattributes` / `.prettierignore` の追記行不足は、{@link import("./planner.js").buildSyncPlan}
 * が既に判定しているのと同じ情報である（diff と同じ plan を読み取るだけ）。二重に判定ロジックを持つと
 * diff と doctor の結果がずれる恐れがあるため、ここでも buildSyncPlan を再利用し単一の正とする。
 *
 * 重大度の方針:
 *   - FAIL: 必須アーティファクトの欠如・schema 違反・人間による managed file の直接編集など、
 *     安全に自動修復できない、または見過ごすとセキュリティ/正しさに影響する状態。
 *   - WARN: `aro sync` で自動的に解消される drift（orphaned managed file・patch 未追記）や、
 *     許容されるが注意を要する設定（legacy `ai-improve` workflow の残置・workflow の @main 参照・
 *     空 command）。
 */
import { lstat } from "node:fs/promises";
import path from "node:path";

import { AroError } from "./errors.js";
import { readFileWithinRoot } from "./filesystem.js";
import { DEFAULT_SOURCE_REPOSITORY, LOCKFILE_RELATIVE_PATH, loadLockFile, type LockFile } from "./lockfile.js";
import { validateJsonSchema } from "./json-schema.js";
import { PROJECT_YAML_PATH } from "./manifest.js";
import { planHasContentDrift } from "./plan-summary.js";
import { buildSyncPlan } from "./planner.js";
import type { LoadedDistribution } from "./source.js";
import { parseYaml } from "./yaml.js";
import type { SyncPlan } from "../types/plan.js";

/** 1 チェックの結果種別。 */
export type DoctorStatus = "pass" | "warn" | "fail";

/** 1 件の診断結果。 */
export interface DoctorCheck {
  /** 安定した識別子（テスト・JSON 消費側向け。人間向け表示には使わない）。 */
  id: string;
  status: DoctorStatus;
  /** 人間向けメッセージ（1 行）。 */
  message: string;
  /** 復旧・対応のヒント（あれば追加行として表示）。 */
  hint?: string | undefined;
}

/** 診断結果の集計。 */
export interface DoctorSummary {
  passed: number;
  warned: number;
  failed: number;
}

/** {@link runDoctor} の結果全体。 */
export interface DoctorReport {
  /** 対象 repo root（絶対 path）。 */
  repoRoot: string;
  /** 全チェック結果（実行順）。 */
  checks: DoctorCheck[];
  summary: DoctorSummary;
  /** FAIL が 1 件でもあるか（exit code 判定に使う）。 */
  hasFailures: boolean;
}

/** {@link runDoctor} の入力。 */
export interface RunDoctorInput {
  /** 対象 repo root（絶対 path 推奨）。 */
  repoRoot: string;
  /** 読み込み済み source distribution。 */
  distribution: LoadedDistribution;
  /** authoritative project schema（`schemas/project.schema.json` を JSON.parse した値）。 */
  projectSchema: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 対象 repo 配下のテキストファイルを読む。存在しなければ null。symlink 非追従・traversal 拒否込み。 */
async function readTargetText(repoRoot: string, relPath: string, label: string): Promise<string | null> {
  const buffer = await readFileWithinRoot(repoRoot, relPath, label);
  return buffer === null ? null : buffer.toString("utf8");
}

/**
 * 例外から DoctorCheck.hint 用の文字列を取り出す。
 *
 * `AroError` は `hint`（無ければ `message`）を使う。`loadLockFile` / `buildSyncPlan` が
 * `AroError` 以外の想定外エラー（I/O エラー・バグ等）を投げた場合でも `message` を fallback として使い、
 * 「failed validation」「could not be computed」としか表示されず実際の原因が分からなくなる事態を防ぐ。
 */
function errorHint(error: unknown): string | undefined {
  if (error instanceof AroError) {
    return error.hint ?? error.message;
  }
  return error instanceof Error ? error.message : undefined;
}

/** Repository: `.git` エントリの有無で Git repo root かどうかを判定する（§17.4 Repository）。 */
async function checkGitRepo(repoRoot: string): Promise<DoctorCheck> {
  try {
    const stats = await lstat(path.join(repoRoot, ".git"));
    if (stats.isDirectory() || stats.isFile() || stats.isSymbolicLink()) {
      return { id: "git.repo", status: "pass", message: "repo is a Git repository root" };
    }
  } catch {
    // ENOENT 等はそのまま下の FAIL に落ちる。
  }
  return {
    id: "git.repo",
    status: "fail",
    message: "repo is not a Git repository root (.git not found)",
    hint: "対象 repo の root で `git init` を実行してください。",
  };
}

/** project.yaml の `commands` / `quality_gates.required` 整合性チェック（§12 / §17.4 Commands）。 */
function checkCommandsAndQualityGates(parsed: unknown): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (!isRecord(parsed)) {
    return checks;
  }
  const commands = isRecord(parsed["commands"]) ? parsed["commands"] : {};
  const qualityGates = parsed["quality_gates"];
  const required =
    isRecord(qualityGates) && Array.isArray(qualityGates["required"])
      ? qualityGates["required"].filter((v): v is string => typeof v === "string")
      : [];

  for (const gate of required) {
    if (!Object.hasOwn(commands, gate)) {
      checks.push({
        id: `commands.quality-gate-missing.${gate}`,
        status: "fail",
        message: `required command "${gate}" is listed in quality_gates but missing in commands`,
      });
    }
  }

  for (const [name, value] of Object.entries(commands)) {
    if (typeof value === "string" && value.length === 0) {
      checks.push({ id: `commands.empty.${name}`, status: "warn", message: `command "${name}" is empty` });
    }
  }

  return checks;
}

/** `.ai/project.yaml` の存在・authoritative schema 検証・commands/quality_gates チェック。 */
async function checkProjectYaml(repoRoot: string, projectSchema: unknown): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const text = await readTargetText(repoRoot, PROJECT_YAML_PATH, "project.yaml");
  if (text === null) {
    checks.push({
      id: "project-yaml.exists",
      status: "fail",
      message: `${PROJECT_YAML_PATH} does not exist`,
      hint: "`aro init --repo .` を実行してください。",
    });
    return checks;
  }
  checks.push({ id: "project-yaml.exists", status: "pass", message: `${PROJECT_YAML_PATH} exists` });

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    checks.push({
      id: "project-yaml.schema",
      status: "fail",
      message: `${PROJECT_YAML_PATH} could not be parsed as YAML`,
      hint: error instanceof Error ? error.message : undefined,
    });
    return checks;
  }

  const issues = validateJsonSchema(projectSchema, parsed);
  if (issues.length === 0) {
    checks.push({ id: "project-yaml.schema", status: "pass", message: "project schema is valid using source schema" });
  } else {
    checks.push({
      id: "project-yaml.schema",
      status: "fail",
      message: `${PROJECT_YAML_PATH} failed validation against the central source schema`,
      hint: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    });
  }

  checks.push(...checkCommandsAndQualityGates(parsed));
  return checks;
}

/** `.ai/ai-repo-ops.lock.yaml` の存在・schema 検証。 */
async function checkLockFile(repoRoot: string): Promise<{ checks: DoctorCheck[]; lock: LockFile | null }> {
  try {
    const lock = await loadLockFile(repoRoot);
    if (lock === null) {
      return {
        lock: null,
        checks: [
          {
            id: "lock.exists",
            status: "fail",
            message: `${LOCKFILE_RELATIVE_PATH} does not exist`,
            hint: "`aro init --repo .` を実行してください。",
          },
        ],
      };
    }
    return {
      lock,
      checks: [
        { id: "lock.exists", status: "pass", message: `${LOCKFILE_RELATIVE_PATH} exists` },
        { id: "lock.schema", status: "pass", message: "lock file schema is valid" },
      ],
    };
  } catch (error) {
    return {
      lock: null,
      checks: [
        {
          id: "lock.schema",
          status: "fail",
          message: `${LOCKFILE_RELATIVE_PATH} failed validation`,
          hint: errorHint(error),
        },
      ],
    };
  }
}

/** append_unique_lines patch のうち doctor が個別メッセージを出す対象（§17.4 Runtime / Line endings）。 */
const PATCH_LABELS: Record<string, string> = {
  ".gitignore": "runtime ignore rules",
  ".gitattributes": "LF rules",
  ".prettierignore": "managed file protection rules",
};

/**
 * managed file checksum・orphaned managed file・append_unique_lines patch の充足状況を、
 * diff と同じ {@link buildSyncPlan} から導く。
 */
async function checkSyncPlanDerived(
  repoRoot: string,
  distribution: LoadedDistribution,
  lock: LockFile | null,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let plan: SyncPlan;
  try {
    plan = await buildSyncPlan({ repoRoot, distribution, lock });
  } catch (error) {
    checks.push({
      id: "sync-plan",
      status: "fail",
      message: "sync plan could not be computed (lock / manifest may be inconsistent)",
      hint: errorHint(error),
    });
    return checks;
  }

  if (lock !== null) {
    const managedChanges = plan.changes.filter((c) => c.strategy === "managed_overwrite");
    const conflicts = managedChanges.filter((c) => c.kind === "conflict");
    // update / create は conflict ではない ── ローカル改変ではなく、中央 distribution に対して
    // 単に古い（もしくは未作成）だけの状態。`aro sync` で自動的に解消される drift なので WARN にする
    // （このファイル冒頭の重大度方針どおり）。conflict が無いからといって「checksum は有効」と
    // 断定すると、中央側の更新に追従できていない・ファイルが消えている状態を doctor が見逃してしまう。
    const outdated = managedChanges.filter((c) => c.kind === "update");
    const missing = managedChanges.filter((c) => c.kind === "create");

    for (const c of conflicts) {
      checks.push({
        id: `managed.checksum-mismatch.${c.path}`,
        status: "fail",
        message: `managed file checksum mismatch: ${c.path}${c.reason !== undefined ? ` (${c.reason})` : ""}`,
        hint: `git restore -- ${c.path} && aro sync --repo .`,
      });
    }

    for (const c of outdated) {
      checks.push({
        id: `managed.outdated.${c.path}`,
        status: "warn",
        message: `managed file is out of date with the central distribution: ${c.path}`,
        hint: "`aro sync --repo .` で最新化されます。",
      });
    }

    for (const c of missing) {
      // installedSha256 が付いていれば「過去に一度 sync 済みだったが、その後ディスクから消えた」。
      // 付いていなければ「manifest に追加されたがこの repo ではまだ一度も作成されていない」。
      // どちらも severity は WARN（sync で解消される）だが、メッセージで状況を区別する。
      const wasSynced = c.installedSha256 !== null && c.installedSha256 !== undefined;
      checks.push({
        id: `managed.missing.${c.path}`,
        status: "warn",
        message: wasSynced
          ? `managed file was previously synced but is now missing from disk: ${c.path}`
          : `managed file has not been created yet: ${c.path}`,
        hint: "`aro sync --repo .` で作成されます。",
      });
    }

    if (conflicts.length === 0 && outdated.length === 0 && missing.length === 0) {
      checks.push({ id: "managed.checksums", status: "pass", message: "managed file checksums are valid" });
    }

    for (const o of plan.changes.filter((c) => c.kind === "orphaned")) {
      checks.push({
        id: `managed.orphaned.${o.path}`,
        status: "warn",
        message: `orphaned managed file: ${o.path} (present in lock file but no longer present in source manifest)`,
        hint: "not deleted in MVP; automatic removal / rename migration is a post-MVP feature.",
      });
    }

    // lock の distribution content sha と source のずれ（§10.5）。seed の配布終了のように
    // 実ファイル差分を生まない配布変更でも lock 更新（sync）が必要なことを表面化する。
    if (planHasContentDrift(plan)) {
      checks.push({
        id: "distribution.content-drift",
        status: "warn",
        message: "lock file is out of date with the central distribution content",
        hint: "`aro sync --repo .` で lock file が最新化されます。",
      });
    } else {
      checks.push({
        id: "distribution.content",
        status: "pass",
        message: "lock file is up to date with the central distribution content",
      });
    }
  }

  for (const [patchPath, label] of Object.entries(PATCH_LABELS)) {
    const change = plan.changes.find((c) => c.strategy === "append_unique_lines" && c.path === patchPath);
    if (change === undefined) {
      continue; // manifest がこの path への patch を定義していない。
    }
    if (change.kind === "noop") {
      checks.push({ id: `patch.${patchPath}`, status: "pass", message: `${patchPath} has required ${label}` });
    } else {
      checks.push({
        id: `patch.${patchPath}`,
        status: "warn",
        message: `${patchPath} is missing required lines: ${(change.lines ?? []).join(", ")}`,
        hint: "`aro sync --repo .` で追記されます。",
      });
    }
  }

  return checks;
}

/** workflow 1 件から抽出した情報。 */
interface WorkflowInfo {
  usesRefs: string[];
  /** workflow 全体（top-level またはいずれかの job）が contents:write 相当を付与しているか。 */
  hasContentsWrite: boolean;
}

/**
 * GitHub Actions の `permissions` 値が contents:write 相当を付与するか判定する。
 *
 * `permissions` は object map（例: `{ contents: write }`）だけでなく、scalar shorthand
 * （`permissions: write-all` / `permissions: read-all`）も許容される。`write-all` は
 * `contents: write` を含む全 scope への write を付与するため、object map の `contents: write` と
 * 同様に検出しないと、doctor が「permission に問題なし」と誤報告してしまう。
 */
function permissionsGrantContentsWrite(permissions: unknown): boolean {
  if (typeof permissions === "string") {
    return permissions === "write-all";
  }
  if (isRecord(permissions)) {
    return permissions["contents"] === "write";
  }
  return false;
}

/**
 * workflow YAML を parse し `jobs.*.uses` と contents:write 付与の有無を抽出する。parse 失敗時は null。
 *
 * `permissions` は workflow 全体（top-level）だけでなく job 単位（`jobs.<id>.permissions`）でも
 * 宣言できる。top-level しか見ないと、job 単位で contents:write を付与している workflow を
 * 見逃してしまうため、top-level と全 job の両方を検査する。
 */
function parseWorkflowInfo(yamlText: string): WorkflowInfo | null {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (!isRecord(doc)) {
    return null;
  }
  const jobs = isRecord(doc["jobs"]) ? doc["jobs"] : {};
  const usesRefs: string[] = [];
  let hasContentsWrite = permissionsGrantContentsWrite(doc["permissions"]);
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    if (typeof job["uses"] === "string") {
      usesRefs.push(job["uses"]);
    }
    if (permissionsGrantContentsWrite(job["permissions"])) {
      hasContentsWrite = true;
    }
  }
  return { usesRefs, hasContentsWrite };
}

/**
 * `uses:` 参照が、中央 ai-repo-ops repo の指定 reusable workflow を指しているかを判定する。
 *
 * ファイル名の部分一致（`includes`）では `other-org/other-repo/.github/workflows/<file>` のような
 * 別リポジトリ参照や、同名ファイルを指すローカル workflow まで「中央 reusable workflow を呼んでいる」
 * と誤判定してしまう。owner/repo/path を `@` より前の部分で厳密一致させることでこれを防ぐ。
 */
function expectedReusableWorkflowRef(reusableFilename: string): string {
  return `${DEFAULT_SOURCE_REPOSITORY}/.github/workflows/${reusableFilename}`;
}

/** {@link matchCentralReusableWorkflow} の判定結果種別。 */
type ReusableWorkflowMatch = "matched" | "missing-ref" | "not-found";

/** {@link matchCentralReusableWorkflow} の戻り値。 */
interface ReusableWorkflowLookup {
  status: ReusableWorkflowMatch;
  /** マッチした `uses:` エントリの `@` 以降（version/ref）。matched/missing-ref のときのみ設定される。 */
  ref?: string;
}

/**
 * {@link WorkflowInfo.usesRefs} の中から中央 reusable workflow を指す 1 件を探し、
 * その参照が実行可能な形（`@ref` 付き）かを判定する。
 *
 * GitHub Actions の他リポジトリ reusable workflow 呼び出しは
 * `{owner}/{repo}/.github/workflows/{file}@{ref}` の形式が必須で、`@{ref}`（tag/branch/SHA）を
 * 省略すると GitHub 側が invalid workflow として拒否し実行できない。owner/repo/path が一致していても
 * `@ref` が無ければ「中央 reusable workflow を呼んでいるように見えて実際には動かない」ため、
 * path 一致だけで PASS にはせず区別する。
 *
 * 戻り値の `ref` は、workflow に複数の `uses:` がある場合（中央 workflow 以外の reusable workflow を
 * 別 job で呼んでいる場合など）に、中央 workflow 自身の version だけを {@link checkWorkflow} の
 * `@main` 警告へ渡すために使う。無関係な `uses:` が `@main` でも中央 workflow がタグ固定されていれば
 * 警告を出さない（逆も然り）。
 */
function matchCentralReusableWorkflow(
  usesRefs: readonly string[],
  reusableFilename: string,
): ReusableWorkflowLookup {
  const expected = expectedReusableWorkflowRef(reusableFilename);
  for (const ref of usesRefs) {
    const atIndex = ref.indexOf("@");
    const path = atIndex === -1 ? ref : ref.slice(0, atIndex);
    if (path !== expected) continue;
    const version = atIndex === -1 ? "" : ref.slice(atIndex + 1);
    return { status: version.length > 0 ? "matched" : "missing-ref", ref: version };
  }
  return { status: "not-found" };
}

/** 必須 workflow（ai-review）の診断仕様。 */
interface WorkflowSpec {
  relPath: string;
  reusableFilename: string;
  label: string;
}

const WORKFLOW_SPECS: readonly WorkflowSpec[] = [
  {
    relPath: ".github/workflows/ai-review.yml",
    reusableFilename: "ai-review.reusable.yml",
    label: "ai-review",
  },
];

/**
 * 配布を終了した legacy seed file（計画 03 Stage 2-2）。
 * `create_only` のため配布を止めても既存 repo からは消えない。残置を検出したら
 * 手動削除を促す WARN を出す。存在しないのが正常状態なので、無ければチェック自体を出さない。
 */
const LEGACY_AI_IMPROVE_PATH = ".github/workflows/ai-improve.yml";

async function checkLegacyAiImprove(repoRoot: string): Promise<DoctorCheck[]> {
  const text = await readTargetText(repoRoot, LEGACY_AI_IMPROVE_PATH, "ai-improve workflow");
  if (text === null) return [];
  return [
    {
      id: "workflow.ai-improve.legacy",
      status: "warn",
      message: `${LEGACY_AI_IMPROVE_PATH} is a legacy workflow that is no longer distributed`,
      hint:
        "CI 内で AI 改善は実行しない方針になりました（改善ループはローカルで回します。docs/local-improve-loop.md 参照）。" +
        "`git rm .github/workflows/ai-improve.yml` で削除してください（create_only のため sync では消えません）。",
    },
  ];
}

/** GitHub Actions workflow 1 件の診断（§17.4 GitHub Actions / §13.3）。 */
async function checkWorkflow(repoRoot: string, spec: WorkflowSpec): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const text = await readTargetText(repoRoot, spec.relPath, `${spec.label} workflow`);
  if (text === null) {
    checks.push({
      id: `workflow.${spec.label}.exists`,
      status: "fail",
      message: `${spec.relPath} does not exist`,
      hint: "`aro init --repo .` を実行してください。",
    });
    return checks;
  }
  checks.push({ id: `workflow.${spec.label}.exists`, status: "pass", message: `${spec.label} workflow exists` });

  const info = parseWorkflowInfo(text);
  if (info === null) {
    checks.push({
      id: `workflow.${spec.label}.parse`,
      status: "fail",
      message: `${spec.relPath} could not be parsed as YAML`,
    });
    return checks;
  }

  const reusable = matchCentralReusableWorkflow(info.usesRefs, spec.reusableFilename);
  if (reusable.status === "matched") {
    checks.push({
      id: `workflow.${spec.label}.reusable-call`,
      status: "pass",
      message: `${spec.label} workflow calls the central reusable workflow`,
    });
  } else if (reusable.status === "missing-ref") {
    checks.push({
      id: `workflow.${spec.label}.reusable-call`,
      status: "fail",
      message: `${spec.relPath} references the central reusable workflow without a version ref (@tag/@branch/@sha)`,
      hint: `GitHub Actions は他リポジトリの reusable workflow 呼び出しに @ref を必須とします。例: uses: ${expectedReusableWorkflowRef(spec.reusableFilename)}@v1`,
    });
  } else {
    checks.push({
      id: `workflow.${spec.label}.reusable-call`,
      status: "fail",
      message: `${spec.relPath} does not call the central reusable workflow (expected ${expectedReusableWorkflowRef(spec.reusableFilename)})`,
    });
  }

  // 中央 reusable workflow 自身の ref だけを見る（無関係な job が別の reusable workflow を
  // @main で呼んでいても誤って警告しない・逆に中央 workflow が @main でも見逃さないようにする）。
  if (reusable.ref === "main") {
    checks.push({
      id: `workflow.${spec.label}.ref`,
      status: "warn",
      message: `${spec.relPath} is pinned to @main instead of a released tag`,
      hint: "安定した @v1 等のタグ参照に固定してください。",
    });
  }

  if (info.hasContentsWrite) {
    checks.push({
      id: `workflow.${spec.label}.permissions`,
      status: "fail",
      message: `${spec.label} workflow has contents:write permission`,
      hint: "配布 workflow は contents:write を持つべきではありません（CI 内で AI は書き込みを行いません）。",
    });
  }

  return checks;
}

/**
 * 対象 repo を診断し {@link DoctorReport} を返す（読み取り専用）。
 *
 * @param input 対象 repo root・読み込み済み source distribution・authoritative project schema。
 */
export async function runDoctor(input: RunDoctorInput): Promise<DoctorReport> {
  const repoRoot = path.resolve(input.repoRoot);
  const checks: DoctorCheck[] = [];

  checks.push(await checkGitRepo(repoRoot));
  checks.push(...(await checkProjectYaml(repoRoot, input.projectSchema)));

  const { checks: lockChecks, lock } = await checkLockFile(repoRoot);
  checks.push(...lockChecks);

  checks.push(...(await checkSyncPlanDerived(repoRoot, input.distribution, lock)));

  for (const spec of WORKFLOW_SPECS) {
    checks.push(...(await checkWorkflow(repoRoot, spec)));
  }
  checks.push(...(await checkLegacyAiImprove(repoRoot)));

  const summary: DoctorSummary = {
    passed: checks.filter((c) => c.status === "pass").length,
    warned: checks.filter((c) => c.status === "warn").length,
    failed: checks.filter((c) => c.status === "fail").length,
  };

  return { repoRoot, checks, summary, hasFailures: summary.failed > 0 };
}
