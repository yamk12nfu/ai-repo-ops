/**
 * `aro guard` の判定ロジック（純粋関数。git 実行や FS アクセスを一切行わない）。
 *
 * docs/plans/03-guard-and-improve-loop.md Stage 1-1 に対応する（未 merge の場合はこのモジュールと
 * commands/guard.ts の実装を仕様の正とする）。
 *
 * project.yaml（{@link ProjectConfig}）と risk_level に対応する policy（{@link Policy}）から読んだ
 * 制約を、`<base>...HEAD` の変更ファイル一覧（core/git-diff.ts が取得）に適用する。git 実行
 * （core/git-diff.ts）・設定読み込み（core/project-config.ts, core/policy.ts）から判定ロジックを
 * 分離することで、ここは git・FS 不要にテストできる（commands/guard.ts が glue する）。
 *
 * doctor と同じ思想で、違反は例外を投げず戻り値（violations 配列）で返す。「判定に必要な入力が
 * 読めない」（project.yaml/policy が読めない・git diff が失敗する等）は呼び出し側が事前に AroError で
 * 弾く前提とし、ここでは扱わない。
 */
import picomatch from "picomatch";

import { LOCKFILE_RELATIVE_PATH } from "./lockfile.js";
import type { Policy } from "./policy.js";
import type { ProjectConfig } from "./project-config.js";

/** 1 件の違反種別。 */
export type GuardViolationKind =
  | "forbidden_path"
  | "managed_file"
  | "workflow"
  | "outside_allowed_paths"
  | "too_many_files"
  | "too_many_added_lines";

/** 1 件の違反。 */
export interface GuardViolation {
  kind: GuardViolationKind;
  /** 違反対象の path（ファイル単位の違反のみ設定。change_limits 系違反には無い）。 */
  path?: string;
  /** 人間向けメッセージ（1 行）。 */
  message: string;
  /** change_limits 系違反の上限値。 */
  limit?: number;
  /** change_limits 系違反の実測値。 */
  actual?: number;
}

/** {@link runGuard} の結果集計。 */
export interface GuardSummary {
  /** 検証したファイル数（削除・バイナリも 1 件として含む）。 */
  checkedFiles: number;
  /** 追加行数の合計（バイナリは 0 扱い）。 */
  addedLines: number;
  /** 違反の総数。 */
  violationCount: number;
}

/** {@link runGuard} の結果。 */
export interface GuardReport {
  violations: GuardViolation[];
  summary: GuardSummary;
  /** 違反が 1 件でもあるか（exit code 判定に使う）。 */
  hasViolations: boolean;
}

/**
 * `<base>...HEAD` の変更ファイル 1 件。core/git-diff.ts の `GitDiffEntry` と同じ形をあえて
 * 独立に定義する（このモジュールが git-diff.ts に依存しないようにするため。構造的に互換なので
 * `getChangedFiles` の戻り値をそのまま渡せる）。
 */
export interface GuardChangedFile {
  path: string;
  addedLines: number | null;
  deletedLines: number | null;
}

/** {@link runGuard} の入力。 */
export interface RunGuardInput {
  /** `<base>...HEAD` の変更ファイル一覧（削除・バイナリも含む）。 */
  changedFiles: readonly GuardChangedFile[];
  projectConfig: ProjectConfig;
  policy: Policy;
}

/** glob pattern 1 件分の matcher。 */
interface GuardMatcher {
  pattern: string;
  isMatch: (target: string) => boolean;
}

/**
 * glob pattern から {@link GuardMatcher} を作る。
 * core/manifest.ts の protectedMatcher と同じオプション（dot:true / nocase:true）を使う。
 */
function matcherFor(pattern: string): GuardMatcher {
  return { pattern, isMatch: picomatch(pattern, { dot: true, nocase: true }) };
}

/** matchers のうち target に最初に一致した pattern を返す。無ければ undefined。 */
function firstMatch(matchers: readonly GuardMatcher[], target: string): string | undefined {
  return matchers.find((m) => m.isMatch(target))?.pattern;
}

/** 既定で禁止する managed file の pattern（`.ai/managed/**` と lock file）。 */
const MANAGED_FILE_PATTERNS = [".ai/managed/**", LOCKFILE_RELATIVE_PATH] as const;

/** 既定で禁止する workflow の pattern（設定に依らない。workflow の自己書き換え禁止）。 */
const WORKFLOW_PATTERNS = [".github/workflows/**"] as const;

/** 1 ファイルの検証に使う matcher 一式。`allowed` は未定義なら「制限なし」を表す。 */
interface GuardMatchers {
  forbidden: GuardMatcher[];
  managed: GuardMatcher[];
  workflow: GuardMatcher[];
  allowed: GuardMatcher[] | undefined;
}

/**
 * 1 ファイルを検証し、該当した違反をすべて返す。
 * 同一ファイルが複数 kind に該当する場合（例: `.github/workflows/**` が policy の forbidden_paths にも
 * 列挙されている場合、forbidden_path と workflow の 2 件になる）でも重複除去せずそれぞれ報告する。
 */
function checkFile(file: GuardChangedFile, matchers: GuardMatchers): GuardViolation[] {
  const violations: GuardViolation[] = [];

  const forbiddenHit = firstMatch(matchers.forbidden, file.path);
  if (forbiddenHit !== undefined) {
    violations.push({
      kind: "forbidden_path",
      path: file.path,
      message: `変更が禁止された path です（forbidden_paths: "${forbiddenHit}"）: ${file.path}`,
    });
  }

  if (firstMatch(matchers.managed, file.path) !== undefined) {
    violations.push({
      kind: "managed_file",
      path: file.path,
      message: `managed file / lock file を変更しています: ${file.path}`,
    });
  }

  if (firstMatch(matchers.workflow, file.path) !== undefined) {
    violations.push({
      kind: "workflow",
      path: file.path,
      message: `GitHub Actions workflow を変更しています（自己書き換えは既定で禁止）: ${file.path}`,
    });
  }

  if (matchers.allowed !== undefined && firstMatch(matchers.allowed, file.path) === undefined) {
    violations.push({
      kind: "outside_allowed_paths",
      path: file.path,
      message: `allowed_paths のいずれにも一致しません: ${file.path}`,
    });
  }

  return violations;
}

/**
 * project.yaml と policy から読んだ制約を diff（変更ファイル一覧）に適用し、違反を判定する。
 *
 * 検証項目:
 *   1. forbidden_paths（project.yaml の `ai.forbidden_paths` ∪ policy の `forbidden_paths`）
 *   2. managed files（`.ai/managed/**` と lock file）
 *   3. workflows（`.github/workflows/**`。設定に依らない既定の forbidden）
 *   4. allowed_paths（project.yaml の `ai.allowed_paths` が定義されている場合のみ。未定義なら制限なし）
 *   5. change_limits（変更ファイル数の実効上限は project.yaml 優先・追加行数合計は policy のみ）
 */
export function runGuard(input: RunGuardInput): GuardReport {
  const { changedFiles, projectConfig, policy } = input;

  const forbiddenPatterns = [
    ...(projectConfig.ai?.forbidden_paths ?? []),
    ...(policy.forbidden_paths ?? []),
  ];
  const allowedPatterns = projectConfig.ai?.allowed_paths;

  const matchers: GuardMatchers = {
    forbidden: forbiddenPatterns.map(matcherFor),
    managed: MANAGED_FILE_PATTERNS.map(matcherFor),
    workflow: WORKFLOW_PATTERNS.map(matcherFor),
    allowed: allowedPatterns?.map(matcherFor),
  };

  const violations: GuardViolation[] = [];
  for (const file of changedFiles) {
    violations.push(...checkFile(file, matchers));
  }

  const checkedFiles = changedFiles.length;
  const addedLines = changedFiles.reduce((sum, f) => sum + (f.addedLines ?? 0), 0);

  // 有効な max_changed_files: project.yaml (ai.max_changed_files) が優先、無ければ policy。
  const effectiveMaxChangedFiles =
    projectConfig.ai?.max_changed_files ?? policy.change_limits?.max_changed_files;
  if (effectiveMaxChangedFiles !== undefined && checkedFiles > effectiveMaxChangedFiles) {
    violations.push({
      kind: "too_many_files",
      message: `変更ファイル数が上限を超えています: ${checkedFiles} > ${effectiveMaxChangedFiles}`,
      limit: effectiveMaxChangedFiles,
      actual: checkedFiles,
    });
  }

  // max_added_lines は policy のみ（project.yaml に対応するフィールドが無いため）。
  const maxAddedLines = policy.change_limits?.max_added_lines;
  if (maxAddedLines !== undefined && addedLines > maxAddedLines) {
    violations.push({
      kind: "too_many_added_lines",
      message: `追加行数の合計が上限を超えています: ${addedLines} > ${maxAddedLines}`,
      limit: maxAddedLines,
      actual: addedLines,
    });
  }

  return {
    violations,
    summary: { checkedFiles, addedLines, violationCount: violations.length },
    hasViolations: violations.length > 0,
  };
}
