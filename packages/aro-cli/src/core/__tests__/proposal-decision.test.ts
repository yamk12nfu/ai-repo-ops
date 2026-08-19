import { describe, expect, it } from "vitest";

import {
  isProposalDecisionTarget,
  PROPOSAL_DECISION_GLOB,
  proposalFileStateFromText,
  proposalTransitionViolationMessage,
  type ProposalFileState,
} from "../proposal-decision.js";
import type { ProposalStatus } from "../proposal-frontmatter.js";

/** 有効な frontmatter を持つ proposal テキストを作る。 */
function proposalText(status: string, decision = ""): string {
  return [
    "---",
    "schema_version: 1",
    "id: sample-proposal",
    `status: ${status}`,
    "proposed_at_commit: 0123456789abcdef0123456789abcdef01234567",
    "sources:",
    "  - path: src/index.ts",
    decision,
    "---",
    "",
    "## 課題",
    "本文",
    "",
  ].join("\n");
}

const BUDGET_DECISION = [
  "decision:",
  "  by: fooya",
  "  budget:",
  "    max_changed_files: 15",
  "    max_added_lines: 1200",
  "    reason: schemaとguardを同一revisionで整合させるため",
].join("\n");

function textMessage(base: string, head: string): string | null {
  return proposalTransitionViolationMessage({
    path: ".ai/local/proposals/2026-08-sample.md",
    base: { kind: "proposal", status: "accepted" },
    head: { kind: "proposal", status: "done" },
    baseText: base,
    headText: head,
  });
}

function proposal(status: ProposalStatus): ProposalFileState {
  return { kind: "proposal", status };
}

const ABSENT: ProposalFileState = { kind: "absent" };

function messageFor(base: ProposalFileState, head: ProposalFileState): string | null {
  return proposalTransitionViolationMessage({
    path: ".ai/local/proposals/2026-08-sample.md",
    base,
    head,
  });
}

describe("isProposalDecisionTarget", () => {
  it("PROPOSALS_ROOT 直下の .md のみ対象（proposals check の列挙と揃える）", () => {
    expect(PROPOSAL_DECISION_GLOB).toBe(".ai/local/proposals/*.md");
    expect(isProposalDecisionTarget(".ai/local/proposals/2026-08-x.md")).toBe(true);
    // 拡張子・path の大文字小文字は区別しない（guard の他の matcher と同じ nocase 規約）。
    expect(isProposalDecisionTarget(".ai/local/proposals/2026-08-x.MD")).toBe(true);
    expect(isProposalDecisionTarget(".ai/local/proposals/sub/x.md")).toBe(false);
    expect(isProposalDecisionTarget(".ai/local/proposals/notes.txt")).toBe(false);
    expect(isProposalDecisionTarget(".ai/local/knowledge/overview.md")).toBe(false);
    expect(isProposalDecisionTarget("src/index.ts")).toBe(false);
  });
});

describe("proposalFileStateFromText", () => {
  it("null（revision に不在）は absent", () => {
    expect(proposalFileStateFromText(null)).toEqual({ kind: "absent" });
  });

  it("有効な frontmatter から status を読む", () => {
    expect(proposalFileStateFromText(proposalText("open"))).toEqual(proposal("open"));
    expect(proposalFileStateFromText(proposalText("accepted"))).toEqual(proposal("accepted"));
  });

  it("schema 全体は検証しない（status さえ読めれば遷移は判定できる）", () => {
    // rejected なのに decision が無い＝schema 違反だが、遷移判定には status で足りる
    // （schema 妥当性は proposals check の責務。責務を重複させない）。
    const text = ["---", "status: rejected", "---", "本文"].join("\n");
    expect(proposalFileStateFromText(text)).toEqual(proposal("rejected"));
  });

  it("frontmatter が無い・閉じていない・YAML 不正・status 不正は unreadable", () => {
    expect(proposalFileStateFromText("# frontmatterなし\n").kind).toBe("unreadable");
    expect(proposalFileStateFromText("---\nstatus: open\n").kind).toBe("unreadable");
    expect(proposalFileStateFromText("---\n: {[\n---\n").kind).toBe("unreadable");
    expect(proposalFileStateFromText(proposalText("approved")).kind).toBe("unreadable");
    expect(proposalFileStateFromText("---\n---\n").kind).toBe("unreadable");
  });
});

describe("proposalTransitionViolationMessage: 違反にしない遷移", () => {
  it("（なし）→ open は propose.md の正常な出力", () => {
    expect(messageFor(ABSENT, proposal("open"))).toBeNull();
  });

  it("accepted → done は実装 PR の正常な出力", () => {
    expect(messageFor(proposal("accepted"), proposal("done"))).toBeNull();
  });

  it("status が変わらない編集（実装破棄の記録の追記等）は違反にしない", () => {
    for (const status of ["open", "accepted", "rejected", "done", "superseded"] as const) {
      expect(messageFor(proposal(status), proposal(status))).toBeNull();
    }
  });

  it("accepted → doneで同じbudgetを保持する実装PRは違反にしない", () => {
    const text = proposalText("accepted", BUDGET_DECISION);
    const head = proposalText("done", BUDGET_DECISION);
    expect(textMessage(text, head)).toBeNull();
  });
});

describe("proposalTransitionViolationMessage: budgetの人間判断保護", () => {
  it.each([
    ["付与", proposalText("accepted", "decision:\n  by: fooya"), proposalText("done", BUDGET_DECISION)],
    ["変更", proposalText("accepted", BUDGET_DECISION), proposalText("done", BUDGET_DECISION.replace("1200", "1201"))],
    ["削除", proposalText("accepted", BUDGET_DECISION), proposalText("done", "decision:\n  by: fooya")],
  ])("accepted → doneのbudget%sはproposal_decision違反", (_label, base, head) => {
    const message = textMessage(base, head);
    expect(message).not.toBeNull();
    expect(message).toContain("budget");
  });

  it("新規open Proposalへのbudget混入はstatus遷移が正常でも違反", () => {
    const message = proposalTransitionViolationMessage({
      path: ".ai/local/proposals/2026-08-new.md",
      base: { kind: "absent" },
      head: { kind: "proposal", status: "open" },
      baseText: null,
      headText: proposalText("open", BUDGET_DECISION),
    });
    expect(message).not.toBeNull();
    expect(message).toContain("budget");
  });

  it("baseとHEADが同じ不正budgetでも違反にする", () => {
    const invalid = proposalText(
      "accepted",
      BUDGET_DECISION.replace("max_changed_files: 15", "max_changed_files: 0"),
    );
    const message = textMessage(invalid, invalid);
    expect(message).not.toBeNull();
    expect(message).toContain("budget");
  });
});

describe("proposalTransitionViolationMessage: 違反になる遷移", () => {
  it("新規ファイルの免除は open に限る（accepted 等での新規追加は迂回経路として fail）", () => {
    for (const status of ["accepted", "rejected", "done", "superseded"] as const) {
      expect(messageFor(ABSENT, proposal(status))).toContain("status: open でのみ追加できます");
    }
  });

  it("open → accepted / rejected（採否）は人間のみの遷移として違反", () => {
    expect(messageFor(proposal("open"), proposal("accepted"))).toContain("open → accepted");
    expect(messageFor(proposal("open"), proposal("rejected"))).toContain("open → rejected");
  });

  it("任意 → superseded も人間のみの遷移として違反", () => {
    expect(messageFor(proposal("open"), proposal("superseded"))).toContain("open → superseded");
    expect(messageFor(proposal("accepted"), proposal("superseded"))).toContain(
      "accepted → superseded",
    );
  });

  it("accepted → done 以外の status 変更はすべて違反（open → done で採用を迂回する経路も塞ぐ）", () => {
    expect(messageFor(proposal("open"), proposal("done"))).toContain("open → done");
    expect(messageFor(proposal("rejected"), proposal("open"))).toContain("rejected → open");
    expect(messageFor(proposal("done"), proposal("accepted"))).toContain("done → accepted");
  });

  it("提案ファイルの削除は違反（提案が消えないことの担保）", () => {
    expect(messageFor(proposal("open"), ABSENT)).toContain("削除");
    expect(messageFor(proposal("rejected"), ABSENT)).toContain("削除");
  });

  it("frontmatter が読めない場合は「遷移を判定できない」として違反", () => {
    const unreadable: ProposalFileState = { kind: "unreadable", detail: "テスト用" };
    expect(messageFor(ABSENT, unreadable)).toContain("判定できません");
    expect(messageFor(unreadable, proposal("open"))).toContain("判定できません");
    // HEAD 側が読めない場合は HEAD 側として報告する
    expect(messageFor(proposal("open"), unreadable)).toContain("HEAD");
  });
});
