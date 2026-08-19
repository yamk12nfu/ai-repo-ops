import { describe, expect, it } from "vitest";

import { ProposalError } from "../errors.js";
import {
  parseProposalDocument,
  splitProposalFrontmatter,
} from "../proposal-frontmatter.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface DocOptions {
  status?: string;
  decision?: string;
  extraFrontmatter?: string;
  sourcePath?: string;
  commit?: string;
}

function proposalDoc(options: DocOptions = {}): string {
  const {
    status = "open",
    decision = "",
    extraFrontmatter = "",
    sourcePath = "src/api/client.ts",
    commit = SHA,
  } = options;
  return `---
schema_version: 1
id: reduce-duplicate-fetch
status: ${status}
proposed_at_commit: ${commit}
sources:
  - path: ${sourcePath}
${decision}${extraFrontmatter}---

## 課題

fetchが重複している。
`;
}

const DECISION_BY_ONLY = `decision:
  by: yamk12nfu
`;
const DECISION_FULL = `decision:
  by: yamk12nfu
  reason: 影響範囲に対して効果が小さい。
`;
const DECISION_EMPTY = `decision:
  by: ""
  reason: ""
`;
const DECISION_BUDGET_BOTH = `decision:
  by: fooya
  budget:
    max_changed_files: 15
    max_added_lines: 1200
    reason: "schema・CLI・testsを同一revisionで整合させるため"
`;

describe("splitProposalFrontmatter", () => {
  it("frontmatterと本文を分離する", () => {
    const { frontmatterYaml, body } = splitProposalFrontmatter("---\na: 1\n---\n\n本文\n");
    expect(frontmatterYaml).toBe("a: 1");
    expect(body).toBe("\n本文\n");
  });

  it("CRLFのfrontmatterを分離できる", () => {
    const { frontmatterYaml, body } = splitProposalFrontmatter("---\r\na: 1\r\n---\r\n本文\r\n");
    expect(frontmatterYaml).toBe("a: 1\r");
    expect(body).toBe("本文\r\n");
  });

  it("frontmatterが無いテキストを拒否する", () => {
    expect(() => splitProposalFrontmatter("## 課題\n")).toThrow(ProposalError);
    expect(() => splitProposalFrontmatter("## 課題\n")).toThrow(/frontmatterがありません/u);
  });

  it("先頭の空行を挟んだ `---` をfrontmatterとして扱わない", () => {
    expect(() => splitProposalFrontmatter("\n---\na: 1\n---\n")).toThrow(
      /frontmatterがありません/u,
    );
  });

  it("閉じ `---` が無いfrontmatterを拒否する", () => {
    expect(() => splitProposalFrontmatter("---\na: 1\n")).toThrow(/閉じる `---` がありません/u);
  });
});

describe("parseProposalDocument", () => {
  it("正常なopen提案をparseする", () => {
    const document = parseProposalDocument(proposalDoc());
    expect(document.frontmatter).toEqual({
      schema_version: 1,
      id: "reduce-duplicate-fetch",
      status: "open",
      proposed_at_commit: SHA,
      sources: [{ path: "src/api/client.ts" }],
      decision: { by: "", reason: "" },
    });
    expect(document.body).toContain("## 課題");
  });

  it("decisionのby/reasonが空文字で明示されたopen提案を許可する", () => {
    const document = parseProposalDocument(proposalDoc({ decision: DECISION_EMPTY }));
    expect(document.frontmatter.decision).toEqual({ by: "", reason: "" });
  });

  it("SHA-256（64桁）のproposed_at_commitを許可する", () => {
    const document = parseProposalDocument(proposalDoc({ commit: SHA256 }));
    expect(document.frontmatter.proposed_at_commit).toBe(SHA256);
  });

  it("decision付きのaccepted提案をparseする", () => {
    const document = parseProposalDocument(
      proposalDoc({ status: "accepted", decision: DECISION_BY_ONLY }),
    );
    expect(document.frontmatter.status).toBe("accepted");
    expect(document.frontmatter.decision).toEqual({ by: "yamk12nfu", reason: "" });
  });

  it("reason付きのrejected提案をparseする", () => {
    const document = parseProposalDocument(
      proposalDoc({ status: "rejected", decision: DECISION_FULL }),
    );
    expect(document.frontmatter.decision.reason).not.toBe("");
  });

  it("壊れたYAMLのfrontmatterを拒否する", () => {
    expect(() => parseProposalDocument('---\nid: [unclosed\n---\n本文\n')).toThrow(
      /YAML parseに失敗/u,
    );
  });

  it("sourceRefをエラーメッセージに含める", () => {
    expect(() => parseProposalDocument("本文だけ\n", ".ai/local/proposals/x.md")).toThrow(
      /^\.ai\/local\/proposals\/x\.md: /u,
    );
  });

  it.each(["accepted", "done", "rejected", "superseded"])(
    "statusが%sでdecision.byが空だと拒否する",
    (status) => {
      const decision = status === "rejected" || status === "superseded" ? "" : DECISION_EMPTY;
      expect(() => parseProposalDocument(proposalDoc({ status, decision }))).toThrow(
        /decision\.by/u,
      );
    },
  );

  it("decision.byが空白のみでも空として拒否する", () => {
    expect(() =>
      parseProposalDocument(proposalDoc({ status: "accepted", decision: 'decision:\n  by: "   "\n' })),
    ).toThrow(/decision\.by/u);
  });

  it.each(["rejected", "superseded"])("statusが%sでdecision.reasonが空だと拒否する", (status) => {
    expect(() =>
      parseProposalDocument(proposalDoc({ status, decision: DECISION_BY_ONLY })),
    ).toThrow(/decision\.reason/u);
  });

  it.each(["accepted", "done"])("statusが%sならdecision.reasonは任意", (status) => {
    expect(() =>
      parseProposalDocument(proposalDoc({ status, decision: DECISION_BY_ONLY })),
    ).not.toThrow();
  });

  it.each(["accepted", "done"])("statusが%sなら両軸のbudgetをparseできる", (status) => {
    const document = parseProposalDocument(
      proposalDoc({ status, decision: DECISION_BUDGET_BOTH }),
    );
    expect(document.frontmatter.decision.budget).toEqual({
      max_changed_files: 15,
      max_added_lines: 1200,
      reason: "schema・CLI・testsを同一revisionで整合させるため",
    });
  });

  it("budgetは片軸でもparseできる", () => {
    const document = parseProposalDocument(
      proposalDoc({
        status: "accepted",
        decision: `decision:\n  by: fooya\n  budget:\n    max_added_lines: 1200\n    reason: "行数だけを承認"\n`,
      }),
    );
    expect(document.frontmatter.decision.budget).toEqual({
      max_added_lines: 1200,
      reason: "行数だけを承認",
    });
  });

  it.each([
    ["empty", "    reason: \"理由\"\n"],
    ["missing reason", "    max_changed_files: 15\n"],
    ["blank reason", "    max_changed_files: 15\n    reason: \"   \"\n"],
    ["unknown field", "    max_changed_files: 15\n    reason: \"理由\"\n    scope: all\n"],
    ["negative files", "    max_changed_files: -1\n    reason: \"理由\"\n"],
    ["fractional lines", "    max_added_lines: 1.5\n    reason: \"理由\"\n"],
  ])("不正な%s budgetを拒否する", (_label, budgetBody) => {
    const decision = `decision:\n  by: fooya\n  budget:\n${budgetBody}`;
    expect(() => parseProposalDocument(proposalDoc({ status: "accepted", decision }))).toThrow(
      /budget/u,
    );
  });

  it.each(["open", "rejected", "superseded"])(
    "statusが%sのbudgetを拒否する",
    (status) => {
      expect(() =>
        parseProposalDocument(proposalDoc({ status, decision: DECISION_BUDGET_BOTH })),
      ).toThrow(/budget/u);
    },
  );

  it("未知のstatusを拒否する", () => {
    expect(() => parseProposalDocument(proposalDoc({ status: "merged" }))).toThrow(/status/u);
  });

  it.each(["src/**/*.ts", "docs/[a-z].md", "/etc/passwd", "../outside.ts", "src/../../escape.ts"])(
    "不正またはglobのsource pathを拒否する: %s",
    (sourcePath) => {
      expect(() => parseProposalDocument(proposalDoc({ sourcePath: `"${sourcePath}"` }))).toThrow(
        /source/u,
      );
    },
  );

  it("Next.js route groupなど素の `()` を含むsource pathを許可する", () => {
    const document = parseProposalDocument(
      proposalDoc({ sourcePath: '"app/(app)/expenses/page.tsx"' }),
    );
    expect(document.frontmatter.sources).toEqual([{ path: "app/(app)/expenses/page.tsx" }]);
  });

  it.each(["+(a|b)/x.ts", "@(a|b)/x.ts", "!(a)/x.ts"])(
    "extglobのsource pathを拒否する: %s",
    (sourcePath) => {
      expect(() => parseProposalDocument(proposalDoc({ sourcePath: `"${sourcePath}"` }))).toThrow(
        /globは使えません/u,
      );
    },
  );

  it("source path検証の失敗をTypeErrorに握り潰さず本来のメッセージで報告する", () => {
    const parse = () => parseProposalDocument(proposalDoc({ sourcePath: '"../outside.ts"' }));
    expect(parse).toThrow(ProposalError);
    expect(parse).toThrow(/親ディレクトリ参照/u);
  });

  it("source pathの大文字小文字違いを含む重複を拒否する", () => {
    expect(() =>
      parseProposalDocument(proposalDoc({ extraFrontmatter: "  - path: SRC/API/CLIENT.TS\n" })),
    ).toThrow(/source.*重複/u);
  });

  it("sourcesが空の提案を拒否する", () => {
    const doc = proposalDoc().replace("sources:\n  - path: src/api/client.ts\n", "sources: []\n");
    expect(() => parseProposalDocument(doc)).toThrow(/sources/u);
  });

  it.each(["0123456", SHA.toUpperCase(), `${SHA}0`])(
    "完全なlowercase Git SHAでないproposed_at_commitを拒否する: %s",
    (commit) => {
      expect(() => parseProposalDocument(proposalDoc({ commit }))).toThrow(/proposed_at_commit/u);
    },
  );

  it.each(["Reduce-Duplicate-Fetch", "reduce_duplicate_fetch", "-leading-hyphen"])(
    "kebab-caseでないIDを拒否する: %s",
    (id) => {
      expect(() =>
        parseProposalDocument(proposalDoc().replace("reduce-duplicate-fetch", id)),
      ).toThrow(/ID/u);
    },
  );

  it("未知のフィールドを拒否する", () => {
    expect(() =>
      parseProposalDocument(proposalDoc({ extraFrontmatter: "priority: high\n" })),
    ).toThrow(/priority/u);
  });

  it("schema_versionが1以外の提案を拒否する", () => {
    expect(() => parseProposalDocument(proposalDoc().replace("schema_version: 1", "schema_version: 2"))).toThrow(
      /schema_version/u,
    );
  });
});
