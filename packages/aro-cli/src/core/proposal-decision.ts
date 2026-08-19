/**
 * `aro guard` の `proposal_decision` violation の遷移判定（計画 06 Stage 1-3）。
 *
 * 提案（`.ai/local/proposals/*.md`）の採否は**常に人間が決める**。このモジュールは、merge-base 側と
 * HEAD 側の frontmatter `status` を比較し、「人間のみが行える遷移」を含む PR を機械的に表面化させる
 * （guard 初の、path ではなくファイル内容に基づく判定）。これは強制ではなく可視化であり、
 * `severity: fail` で required check を落とし、人間が内容を確認して明示的に override して merge する
 * 運用を要求する（`project_config` violation と同じ扱い。docs/guard.md 参照）。
 *
 * 責務の境界: frontmatter の schema 妥当性（decision.by の必須性・sources の検証等）は
 * `aro proposals check` の責務。ここでは**遷移の判定に必要な `status` だけ**を読み、schema 全体の
 * 検証は行わない（schema 違反でも status が読めれば遷移は判定できる。逆に status が読めない場合は
 * 「遷移を判定できない」として違反にする）。
 *
 * guard.ts と同じく純粋関数のみ（git 実行・FS アクセスなし）。revision からの読み出しは
 * commands/guard.ts が行い、テキストをここへ渡す。
 */
import picomatch from "picomatch";

import {
  PROPOSAL_STATUSES,
  parseProposalDocument,
  PROPOSALS_ROOT,
  splitProposalFrontmatter,
  type ProposalBudget,
  type ProposalStatus,
} from "./proposal-frontmatter.js";
import { parseYaml } from "./yaml.js";

/**
 * `proposal_decision` の判定対象 pattern。`aro proposals check` の列挙（PROPOSALS_ROOT 直下の
 * `*.md` のみ・非再帰）と揃える。subdirectory や `.md` 以外は proposal ではないため対象外
 * （それらは allowed_paths / forbidden_paths の既存判定に委ねる）。
 */
export const PROPOSAL_DECISION_GLOB = `${PROPOSALS_ROOT}/*.md`;

const proposalDecisionMatcher = picomatch(PROPOSAL_DECISION_GLOB, { dot: true, nocase: true });

/** path が `proposal_decision` の判定対象（proposal ファイル）かを返す。 */
export function isProposalDecisionTarget(path: string): boolean {
  return proposalDecisionMatcher(path);
}

/**
 * ある revision における proposal ファイルの状態。
 * - `absent`: その revision にファイルが存在しない。
 * - `unreadable`: 存在するが frontmatter から `status` を判定できない（parse 失敗・status 不正等）。
 * - `proposal`: `status` が読めた。
 */
export type ProposalFileState =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "proposal"; status: ProposalStatus };

export type ProposalBudgetState =
  | { kind: "absent" }
  | { kind: "valid"; budget: ProposalBudget }
  | { kind: "invalid"; detail: string };

function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/**
 * revision から読んだテキスト（存在しなければ null）を {@link ProposalFileState} へ分類する。
 *
 * schema 全体の zod 検証は意図的に行わない（冒頭コメントの責務境界を参照）。frontmatter の分離と
 * YAML parse に成功し、`status` が既知の値であれば遷移を判定できる。
 */
export function proposalFileStateFromText(text: string | null): ProposalFileState {
  if (text === null) return { kind: "absent" };

  let frontmatterYaml: string;
  try {
    frontmatterYaml = splitProposalFrontmatter(text).frontmatterYaml;
  } catch {
    return { kind: "unreadable", detail: "YAML frontmatterを分離できません" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch {
    return { kind: "unreadable", detail: "frontmatterのYAML parseに失敗しました" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unreadable", detail: "frontmatterがYAML mappingではありません" };
  }
  const status: unknown = (parsed as Record<string, unknown>)["status"];
  if (!isProposalStatus(status)) {
    return {
      kind: "unreadable",
      detail: `statusが不正です（${PROPOSAL_STATUSES.join(" / ")} のいずれかが必要）`,
    };
  }
  return { kind: "proposal", status };
}

/** 1 proposal ファイルの merge-base 側 / HEAD 側の状態。 */
export interface ProposalTransition {
  /** repo root からの相対 path。 */
  path: string;
  /** merge-base 側の状態。 */
  base: ProposalFileState;
  /** HEAD 側の状態。 */
  head: ProposalFileState;
  /** merge-base 側の生テキスト（budget保護とstrict認証に使う。省略時は従来のstatus判定のみ）。 */
  baseText?: string | null;
  /** HEAD 側の生テキスト（budget保護とstrict認証に使う。省略時は従来のstatus判定のみ）。 */
  headText?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function proposalBudgetStateFromText(text: string | null): ProposalBudgetState {
  if (text === null) return { kind: "absent" };

  let frontmatterYaml: string;
  try {
    frontmatterYaml = splitProposalFrontmatter(text).frontmatterYaml;
  } catch {
    return { kind: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch {
    return { kind: "absent" };
  }
  if (!isRecord(parsed) || !isRecord(parsed["decision"]) || !Object.hasOwn(parsed["decision"], "budget")) {
    return { kind: "absent" };
  }

  try {
    const document = parseProposalDocument(text);
    const budget = document.frontmatter.decision.budget;
    return budget === undefined
      ? { kind: "invalid", detail: "decision.budgetを解釈できません" }
      : { kind: "valid", budget };
  } catch (error) {
    return {
      kind: "invalid",
      detail: error instanceof Error ? error.message.split("\n")[0] ?? "schema不適合" : "schema不適合",
    };
  }
}

function sameBudget(left: ProposalBudget, right: ProposalBudget): boolean {
  return (
    left.max_changed_files === right.max_changed_files &&
    left.max_added_lines === right.max_added_lines &&
    left.reason === right.reason
  );
}

export function proposalBudgetTransitionViolationMessage(
  transition: ProposalTransition,
): string | null {
  if (transition.baseText === undefined && transition.headText === undefined) return null;

  const baseBudget = proposalBudgetStateFromText(transition.baseText ?? null);
  const headBudget = proposalBudgetStateFromText(transition.headText ?? null);
  if (baseBudget.kind === "invalid") {
    return `提案のdecision.budgetを解釈できないため、人間の予算承認を検証できません（${baseBudget.detail}）: ${transition.path}`;
  }
  if (headBudget.kind === "invalid") {
    const detail = headBudget.detail;
    return `提案のdecision.budgetを解釈できないため、人間の予算承認を検証できません（${detail}）: ${transition.path}`;
  }
  if (
    (baseBudget.kind === "absent" && headBudget.kind === "absent") ||
    (baseBudget.kind === "valid" && headBudget.kind === "valid" && sameBudget(baseBudget.budget, headBudget.budget))
  ) {
    return null;
  }
  return `提案のdecision.budgetが付与・変更・削除されています。予算承認の変更は人間のみが行えます: ${transition.path}`;
}

/**
 * 遷移を判定し、違反なら人間向けメッセージ（1 行）を、正常な遷移なら null を返す。
 *
 * 違反にしない遷移（計画 06「状態遷移」節）:
 *   - （なし）→ `open`: propose.md の正常な出力。
 *   - `accepted` → `done`: improve ループの実装 PR の正常な出力。
 *   - `status` が変わらない編集: 実装破棄の記録の追記など。
 *
 * それ以外はすべて違反（fail → 人間が確認して override）:
 *   - （なし）→ `open` 以外: 新規ファイル免除の迂回（最初から accepted で生やす経路）を塞ぐ。
 *   - `open` → `accepted` / `rejected`、任意 → `superseded` 等の status 変更: 採否は人間のみ。
 *   - 削除: 「提案が消えないこと」の担保。提案は消さず status で閉じる。
 *   - frontmatter が読めない: 遷移を判定できない。
 */
export function proposalTransitionViolationMessage(transition: ProposalTransition): string | null {
  const { path, base, head } = transition;

  const budgetMessage = proposalBudgetTransitionViolationMessage(transition);
  if (budgetMessage !== null) return budgetMessage;

  if (base.kind === "unreadable" || head.kind === "unreadable") {
    const side = head.kind === "unreadable" ? head : (base as { detail: string });
    const revision = head.kind === "unreadable" ? "HEAD" : "merge-base";
    return `提案のfrontmatterからstatusを読めず、採否の遷移を判定できません（${revision}側: ${side.detail}）: ${path}`;
  }

  if (base.kind === "absent") {
    if (head.kind === "absent") return null;
    if (head.status === "open") return null;
    return `新規の提案は status: open でのみ追加できます（status: ${head.status} での新規追加は採否検証の迂回経路になります）: ${path}`;
  }

  if (head.kind === "absent") {
    return `提案ファイルの削除です。提案は削除せず status で閉じてください（人間の判断による削除なら、内容を確認のうえ override して merge してください）: ${path}`;
  }

  if (base.status === head.status) return null;
  if (base.status === "accepted" && head.status === "done") return null;

  return `提案の採否・状態の変更（${base.status} → ${head.status}）です。この遷移は人間のみが行えます。人間の判断による変更であることを内容で確認し、required check を明示的に override して merge してください: ${path}`;
}
