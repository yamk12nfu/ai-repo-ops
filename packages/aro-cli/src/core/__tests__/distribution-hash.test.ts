import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CHECKSUM_MODE } from "../checksum.js";
import {
  buildDistributionHashPayload,
  computeDistributionContentSha256,
  stableJson,
  type DistributionHashInput,
} from "../distribution-hash.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

/** テスト用の基準入力。 */
function baseInput(): DistributionHashInput {
  return {
    schema_version: 1,
    distribution: "base",
    managed_files: [
      { dest: ".ai/managed/prompts/review.md", sha256: SHA_A },
      { dest: ".ai/managed/policies/default.yaml", sha256: SHA_B },
    ],
    seed_files: [{ dest: ".ai/project.yaml", source_kind: "template", sha256: SHA_C }],
    patches: [{ path: ".gitignore", lines: [".ai/runs/", ".ai/tmp/", ".ai/logs/"] }],
  };
}

describe("stableJson", () => {
  it("object key を再帰的に昇順で並べる", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("配列の順序は保持する", () => {
    expect(stableJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("余分な空白を入れない", () => {
    expect(stableJson({ x: [1, { y: 2 }] })).toBe('{"x":[1,{"y":2}]}');
  });

  it("null / 文字列 / 数値をそのまま JSON 化する", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson("a")).toBe('"a"');
    expect(stableJson(42)).toBe("42");
  });
});

describe("buildDistributionHashPayload", () => {
  it("managed_files / seed_files を dest 昇順に並べる", () => {
    const payload = buildDistributionHashPayload(baseInput());
    expect(payload.managed_files.map((m) => m.dest)).toEqual([
      ".ai/managed/policies/default.yaml",
      ".ai/managed/prompts/review.md",
    ]);
  });

  it("strategy / checksum_mode を固定値で埋める", () => {
    const payload = buildDistributionHashPayload(baseInput());
    expect(payload.checksum_mode).toBe(CHECKSUM_MODE);
    expect(payload.managed_files.every((m) => m.strategy === "managed_overwrite")).toBe(true);
    expect(payload.seed_files.every((s) => s.strategy === "create_only")).toBe(true);
  });

  it("patches を (type, path, lines) で並べつつ lines の中身は保持する", () => {
    const payload = buildDistributionHashPayload({
      ...baseInput(),
      patches: [
        { path: ".prettierignore", lines: ["z", "a"] },
        { path: ".gitignore", lines: [".ai/runs/"] },
      ],
    });
    expect(payload.patches.map((p) => p.path)).toEqual([".gitignore", ".prettierignore"]);
    // lines は sort されない（追記順を保持）。
    expect(payload.patches[1]?.lines).toEqual(["z", "a"]);
  });
});

describe("computeDistributionContentSha256", () => {
  it("hex lowercase 64 桁を返す", () => {
    const hash = computeDistributionContentSha256(buildDistributionHashPayload(baseInput()));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("正規 payload の stableJson に対する SHA-256 と一致する", () => {
    const payload = buildDistributionHashPayload(baseInput());
    const expected = createHash("sha256").update(Buffer.from(stableJson(payload), "utf8")).digest("hex");
    expect(computeDistributionContentSha256(payload)).toBe(expected);
  });

  it("エントリ順を変えても hash は変わらない", () => {
    const a = computeDistributionContentSha256(buildDistributionHashPayload(baseInput()));
    const reordered = baseInput();
    reordered.managed_files = [...reordered.managed_files].reverse();
    const b = computeDistributionContentSha256(buildDistributionHashPayload(reordered));
    expect(b).toBe(a);
  });

  it("managed file の内容（sha256）が変われば hash も変わる", () => {
    const a = computeDistributionContentSha256(buildDistributionHashPayload(baseInput()));
    const changed = baseInput();
    changed.managed_files = [{ dest: ".ai/managed/prompts/review.md", sha256: SHA_C }, changed.managed_files[1]!];
    const b = computeDistributionContentSha256(buildDistributionHashPayload(changed));
    expect(b).not.toBe(a);
  });

  it("patch lines の順序が変われば hash も変わる（追記順は意味を持つ）", () => {
    const a = computeDistributionContentSha256(buildDistributionHashPayload(baseInput()));
    const changed = baseInput();
    changed.patches = [{ path: ".gitignore", lines: [".ai/tmp/", ".ai/runs/", ".ai/logs/"] }];
    const b = computeDistributionContentSha256(buildDistributionHashPayload(changed));
    expect(b).not.toBe(a);
  });
});
