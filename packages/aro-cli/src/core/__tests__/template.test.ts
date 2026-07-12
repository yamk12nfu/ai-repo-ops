import { describe, expect, it } from "vitest";

import {
  deriveRepoName,
  renderTemplate,
  resolveTemplateRepoName,
} from "../template.js";

describe("renderTemplate", () => {
  it("{{ repo_name }}（前後空白あり）を置換する", () => {
    expect(renderTemplate('name: "{{ repo_name }}"\n', { repo_name: "product-a" })).toBe(
      'name: "product-a"\n',
    );
  });

  it("{{repo_name}}（空白なし）も置換する", () => {
    expect(renderTemplate("name: {{repo_name}}\n", { repo_name: "x" })).toBe("name: x\n");
  });

  it("同じ変数が複数あればすべて置換する", () => {
    expect(renderTemplate("{{ repo_name }}-{{ repo_name }}", { repo_name: "r" })).toBe("r-r");
  });

  it("未知のプレースホルダはリテラルのまま残す", () => {
    expect(renderTemplate("{{ unknown }} {{ repo_name }}", { repo_name: "r" })).toBe(
      "{{ unknown }} r",
    );
  });

  it("プレースホルダが無ければ入力をそのまま返す", () => {
    expect(renderTemplate("no placeholders here\n", { repo_name: "r" })).toBe(
      "no placeholders here\n",
    );
  });

  it("Object.prototype のメンバ名（constructor 等）はリテラルのまま残す（prototype 汚染防止）", () => {
    for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(renderTemplate(`{{ ${name} }}`, { repo_name: "r" })).toBe(`{{ ${name} }}`);
    }
  });

  it("repo_name に $ を含んでもリテラルとして置換される（replace の $ 解釈を受けない）", () => {
    expect(renderTemplate("name: {{ repo_name }}", { repo_name: "a$1b$&c" })).toBe("name: a$1b$&c");
  });
});

describe("deriveRepoName", () => {
  it("絶対 path の basename を返す", () => {
    expect(deriveRepoName("/tmp/product-a")).toBe("product-a");
  });

  it("末尾区切り付きでも basename を返す", () => {
    expect(deriveRepoName("/tmp/product-a/")).toBe("product-a");
  });

  it("root（/）など basename が空なら repo にフォールバックする", () => {
    expect(deriveRepoName("/")).toBe("repo");
  });
});

describe("resolveTemplateRepoName", () => {
  it("project.nameをdirectory名より優先する", () => {
    expect(resolveTemplateRepoName("/tmp/checkout", "demo")).toBe("demo");
  });

  it("project.nameが無ければdirectory名へfallbackする", () => {
    expect(resolveTemplateRepoName("/tmp/checkout")).toBe("checkout");
  });
});
