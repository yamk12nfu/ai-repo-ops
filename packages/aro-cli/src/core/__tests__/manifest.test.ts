import { describe, expect, it } from "vitest";

import { ManifestError } from "../errors.js";
import { parseManifest } from "../manifest.js";

/** 最小の有効 manifest を返す。 */
function validManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "base",
    version: "0.1.0",
    files: [
      {
        src: "files/.ai/managed/prompts/review.md",
        dest: ".ai/managed/prompts/review.md",
        strategy: "managed_overwrite",
      },
    ],
    seed_files: [{ dest: ".ai/project.yaml", template: "project.yaml.hbs", strategy: "create_only" }],
    patches: [{ type: "append_unique_lines", path: ".gitignore", lines: [".ai/runs/"] }],
    preserve: [".ai/project.yaml", ".ai/local/**"],
  };
}

describe("parseManifest（正常系）", () => {
  it("有効な manifest を検証して返す", () => {
    const manifest = parseManifest(validManifest());
    expect(manifest.name).toBe("base");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.files).toHaveLength(1);
    expect(manifest.seed_files[0]?.template).toBe("project.yaml.hbs");
  });

  it("files / seed_files / patches / preserve 省略時は空配列になる", () => {
    const manifest = parseManifest({ schema_version: 1, name: "base", version: "1.2.3" });
    expect(manifest.files).toEqual([]);
    expect(manifest.seed_files).toEqual([]);
    expect(manifest.patches).toEqual([]);
    expect(manifest.preserve).toEqual([]);
  });

  it("dest の path を POSIX 正規化する", () => {
    const m = validManifest();
    (m["files"] as Array<Record<string, unknown>>)[0]!["dest"] = "./.ai/managed/prompts/review.md";
    expect(parseManifest(m).files[0]?.dest).toBe(".ai/managed/prompts/review.md");
  });
});

describe("parseManifest（壊れた manifest）", () => {
  it("schema_version が無いと ManifestError", () => {
    const m = validManifest();
    delete m["schema_version"];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("schema_version が 1 以外だと ManifestError", () => {
    expect(() => parseManifest({ ...validManifest(), schema_version: 2 })).toThrowError(ManifestError);
  });

  it("name が無いと ManifestError", () => {
    const m = validManifest();
    delete m["name"];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("version が semver でないと ManifestError", () => {
    expect(() => parseManifest({ ...validManifest(), version: "v1" })).toThrowError(/semver/);
  });

  it("未知のトップレベル key（typo）を拒否する", () => {
    expect(() => parseManifest({ ...validManifest(), fies: [] })).toThrowError(ManifestError);
  });

  it("files[].strategy が managed_overwrite 以外だと ManifestError", () => {
    const m = validManifest();
    (m["files"] as Array<Record<string, unknown>>)[0]!["strategy"] = "create_only";
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("絶対 path の src を拒否する", () => {
    const m = validManifest();
    (m["files"] as Array<Record<string, unknown>>)[0]!["src"] = "/etc/passwd";
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it(".. を含む dest を拒否する", () => {
    const m = validManifest();
    (m["files"] as Array<Record<string, unknown>>)[0]!["dest"] = "../escape.md";
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });
});

describe("parseManifest（seed_files の src/template 排他）", () => {
  it("src と template の両方を持つと ManifestError", () => {
    const m = validManifest();
    m["seed_files"] = [
      { dest: ".ai/project.yaml", src: "files/x", template: "y.hbs", strategy: "create_only" },
    ];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("src も template も無いと ManifestError", () => {
    const m = validManifest();
    m["seed_files"] = [{ dest: ".ai/project.yaml", strategy: "create_only" }];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("seed_files[].strategy が create_only 以外だと ManifestError", () => {
    const m = validManifest();
    m["seed_files"] = [
      { dest: ".ai/project.yaml", template: "y.hbs", strategy: "managed_overwrite" },
    ];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });
});

describe("parseManifest（preserve × managed_overwrite 衝突 §9.4）", () => {
  it("managed dest が preserve パターンに一致すると ManifestError", () => {
    const m = validManifest();
    m["files"] = [
      { src: "files/x", dest: ".ai/local/keep.md", strategy: "managed_overwrite" },
    ];
    m["preserve"] = [".ai/local/**"];
    expect(() => parseManifest(m)).toThrowError(/preserve/);
  });

  it("完全一致の preserve とも衝突する", () => {
    const m = validManifest();
    m["files"] = [{ src: "files/x", dest: ".ai/project.yaml", strategy: "managed_overwrite" }];
    m["preserve"] = [".ai/project.yaml"];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("preserve の表記ゆれ（./ 付き）でも正規化して保護判定する（§指摘2）", () => {
    const m = validManifest();
    // 固定保護 path ではない custom/ を preserve に書く（正規化されないと dest と一致しない）。
    m["files"] = [{ src: "files/x", dest: "custom/keep.md", strategy: "managed_overwrite" }];
    m["preserve"] = ["./custom/**"];
    expect(() => parseManifest(m)).toThrowError(/preserve/);
  });
});

describe("parseManifest（固定保護 path §20.3 / 指摘1）", () => {
  it.each([".env", "secrets/api.key", ".ai/local/extra.md", ".ai/project.yaml"])(
    "preserve に書かれていなくても managed_overwrite dest %s を拒否する",
    (dest) => {
      const m = validManifest();
      m["files"] = [{ src: "files/x", dest, strategy: "managed_overwrite" }];
      m["preserve"] = []; // preserve 漏れでも保護されることを確認する。
      expect(() => parseManifest(m)).toThrowError(/固定保護|§20\.3/);
    },
  );

  it(".env.* パターンで .env.local を拒否する", () => {
    const m = validManifest();
    m["files"] = [{ src: "files/x", dest: ".env.local", strategy: "managed_overwrite" }];
    m["preserve"] = [];
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it("create_only seed でも .env / secrets / .ai/local を拒否する", () => {
    const m = validManifest();
    m["seed_files"] = [{ dest: ".env", src: "files/x", strategy: "create_only" }];
    expect(() => parseManifest(m)).toThrowError(/固定保護|§20\.3/);
  });

  it("create_only seed の .ai/project.yaml は許可する（例外）", () => {
    const m = validManifest();
    m["seed_files"] = [
      { dest: ".ai/project.yaml", template: "project.yaml.hbs", strategy: "create_only" },
    ];
    expect(() => parseManifest(m)).not.toThrow();
  });

  it("patch 対象が固定保護 path だと拒否する", () => {
    const m = validManifest();
    m["patches"] = [{ type: "append_unique_lines", path: ".env", lines: ["X=1"] }];
    expect(() => parseManifest(m)).toThrowError(/固定保護|§20\.3/);
  });
});
