import { describe, expect, it } from "vitest";

import { parseYaml, stringifyYaml } from "../yaml.js";

describe("parseYaml / stringifyYaml", () => {
  it("基本的な値を round-trip できる", () => {
    const value = { a: 1, b: ["x", "y"], c: { d: null } };
    expect(parseYaml(stringifyYaml(value))).toEqual(value);
  });

  it("入力オブジェクトの key 順を保持する", () => {
    const text = stringifyYaml({ b: 1, a: 2 });
    expect(text.indexOf("b:")).toBeLessThan(text.indexOf("a:"));
  });

  it("anchor/alias を生成しない（重複オブジェクトを展開する）", () => {
    const shared = { k: "v" };
    const text = stringifyYaml({ first: shared, second: shared });
    expect(text).not.toContain("&");
    expect(text).not.toContain("*");
  });

  it("壊れた YAML は例外を投げる", () => {
    expect(() => parseYaml("a: [\n")).toThrowError();
  });
});
