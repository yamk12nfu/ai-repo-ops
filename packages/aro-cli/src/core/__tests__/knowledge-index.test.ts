import { describe, expect, it } from "vitest";

import { parseKnowledgeIndex } from "../knowledge-index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function indexYaml(entryOverrides = ""): string {
  return `schema_version: 1
entries:
  - id: auth-token-lifecycle
    document: architecture.md
    verified_at_commit: ${SHA}
    sources:
      - path: src/auth/token-service.ts
${entryOverrides}`;
}

describe("parseKnowledgeIndex", () => {
  it("根拠付きdocumentをparseする", () => {
    expect(parseKnowledgeIndex(indexYaml())).toEqual({
      schema_version: 1,
      entries: [
        {
          id: "auth-token-lifecycle",
          document: "architecture.md",
          verified_at_commit: SHA,
          sources: [{ path: "src/auth/token-service.ts" }],
        },
      ],
    });
  });

  it("空のentriesを初期状態として許可する", () => {
    expect(parseKnowledgeIndex("schema_version: 1\nentries: []\n")).toEqual({
      schema_version: 1,
      entries: [],
    });
  });

  it("IDの大文字小文字違いを含む重複を拒否する", () => {
    const yaml = `${indexYaml()}  - id: AUTH-TOKEN-LIFECYCLE
    document: duplicate.md
    verified_at_commit: ${SHA}
    sources:
      - path: docs/auth.md
`;
    expect(() => parseKnowledgeIndex(yaml)).toThrow(/ID.*重複/u);
  });

  it("document pathの大文字小文字違いを含む重複を拒否する", () => {
    const yaml = `${indexYaml()}  - id: another-entry
    document: Architecture.md
    verified_at_commit: ${SHA}
    sources:
      - path: docs/auth.md
`;
    expect(() => parseKnowledgeIndex(yaml)).toThrow(/document.*重複/u);
  });

  it("同一entry内のsource重複を拒否する", () => {
    const yaml = indexYaml("      - path: SRC/AUTH/TOKEN-SERVICE.TS\n");
    expect(() => parseKnowledgeIndex(yaml)).toThrow(/source.*重複/u);
  });

  it.each(["../outside.md", "/absolute.md", "notes.txt", "docs/*.md"])(
    "不正なdocument pathを拒否する: %s",
    (document) => {
      expect(() => parseKnowledgeIndex(indexYaml().replace("architecture.md", document))).toThrow(
        /document/u,
      );
    },
  );

  it.each(["../secret", "/etc/passwd", "src/**/*.ts", "docs/[a-z].md"])(
    "不正またはglobのsource pathを拒否する: %s",
    (source) => {
      expect(() =>
        parseKnowledgeIndex(indexYaml().replace("src/auth/token-service.ts", source)),
      ).toThrow(/source/u);
    },
  );

  it("sourceが空のentryを拒否する", () => {
    const yaml = indexYaml().replace("    sources:\n      - path: src/auth/token-service.ts\n", "    sources: []\n");
    expect(() => parseKnowledgeIndex(yaml)).toThrow(/sources/u);
  });

  it.each(["abc123", "ABCDEF0123456789ABCDEF0123456789ABCDEF01"])(
    "完全なlowercase Git SHAでないverified_at_commitを拒否する: %s",
    (sha) => {
      expect(() => parseKnowledgeIndex(indexYaml().replace(SHA, sha))).toThrow(/verified_at_commit/u);
    },
  );

  it("未知フィールドを拒否する", () => {
    expect(() => parseKnowledgeIndex(`${indexYaml()}unexpected: true\n`)).toThrow(/unexpected/u);
  });
});
