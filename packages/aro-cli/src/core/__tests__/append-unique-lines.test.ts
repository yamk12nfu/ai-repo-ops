import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendUniqueLinesWithinRoot,
  applyAppendUniqueLines,
  computeAppendUniqueLines,
} from "../append-unique-lines.js";
import { PathSafetyError } from "../errors.js";
import { readFileIfExists } from "../filesystem.js";

describe("computeAppendUniqueLines", () => {
  it("ファイルが無い場合は指定行で新規作成する", () => {
    const result = computeAppendUniqueLines(null, [".ai/runs/", ".ai/tmp/", ".ai/logs/"]);
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.addedLines).toEqual([".ai/runs/", ".ai/tmp/", ".ai/logs/"]);
    expect(result.content).toBe(".ai/runs/\n.ai/tmp/\n.ai/logs/\n");
  });

  it("新規作成時、追記候補内の重複を除去する", () => {
    const result = computeAppendUniqueLines(null, ["a", "a", "b"]);
    expect(result.addedLines).toEqual(["a", "b"]);
    expect(result.content).toBe("a\nb\n");
  });

  it("既存行と重複する行は追記しない", () => {
    const result = computeAppendUniqueLines("a\nb\n", ["b", "c"]);
    expect(result.addedLines).toEqual(["c"]);
    expect(result.content).toBe("a\nb\nc\n");
  });

  it("全行が既存に揃っている場合は変更なし（重複行を作らない）", () => {
    const result = computeAppendUniqueLines("a\nb\n", ["a", "b"]);
    expect(result.changed).toBe(false);
    expect(result.addedLines).toEqual([]);
  });

  it("末尾改行が無い既存ファイルにも単一改行を挟んで追記する", () => {
    const result = computeAppendUniqueLines("a\nb", ["c"]);
    expect(result.content).toBe("a\nb\nc\n");
  });

  it("CRLF の既存ファイルでも内容一致なら変更なしと判定する", () => {
    const result = computeAppendUniqueLines("a\r\nb\r\n", ["a", "b"]);
    expect(result.changed).toBe(false);
  });

  it("既存行の順序とコメントを保持する", () => {
    const existing = "# header comment\nz\na\n";
    const result = computeAppendUniqueLines(existing, ["a", "new"]);
    expect(result.content).toBe("# header comment\nz\na\nnew\n");
  });

  it("追記候補が既存と新規の重複を跨いでも一度だけ追記する", () => {
    const result = computeAppendUniqueLines("a\n", ["b", "b", "a"]);
    expect(result.addedLines).toEqual(["b"]);
    expect(result.content).toBe("a\nb\n");
  });

  it("空行(\"\")の追記可否が末尾改行の有無で揺れない", () => {
    // 末尾改行由来の phantom 空セグメントを既存行として数えないので、両者は同一結果になる。
    const withTrailingNewline = computeAppendUniqueLines("a\nb\n", [""]);
    const withoutTrailingNewline = computeAppendUniqueLines("a\nb", [""]);
    expect(withTrailingNewline.content).toBe(withoutTrailingNewline.content);
    expect(withTrailingNewline.changed).toBe(withoutTrailingNewline.changed);
    expect(withTrailingNewline.content).toBe("a\nb\n\n");
  });

  it("既存の途中に空行があれば、空行の追記はスキップする", () => {
    const result = computeAppendUniqueLines("a\n\nb\n", [""]);
    expect(result.changed).toBe(false);
  });
});

describe("applyAppendUniqueLines (file)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "aro-append-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("初回は作成し、2回目は冪等（重複追記しない）", async () => {
    const target = path.join(workDir, ".gitattributes");
    const lines = [
      "# ai-repo-ops managed text files",
      ".ai/managed/** text eol=lf",
      ".ai/project.yaml text eol=lf",
    ];

    const first = await applyAppendUniqueLines(target, lines);
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);

    const second = await applyAppendUniqueLines(target, lines);
    expect(second.changed).toBe(false);
    expect(second.addedLines).toEqual([]);

    const content = (await readFile(target)).toString("utf8");
    expect(content).toBe(`${lines.join("\n")}\n`);
    // 重複が無いこと（各行がちょうど1回）。
    for (const line of lines) {
      expect(content.split("\n").filter((value) => value === line)).toHaveLength(1);
    }
  });

  it("既存の .prettierignore に必要行を重複なく追記する", async () => {
    const target = path.join(workDir, ".prettierignore");
    await writeFile(target, "node_modules\n.ai/managed/\n");

    const result = await applyAppendUniqueLines(target, [
      "# ai-repo-ops managed files",
      ".ai/managed/",
      ".ai/ai-repo-ops.lock.yaml",
    ]);

    expect(result.addedLines).toEqual([
      "# ai-repo-ops managed files",
      ".ai/ai-repo-ops.lock.yaml",
    ]);
    const content = (await readFile(target)).toString("utf8");
    expect(content).toBe(
      "node_modules\n.ai/managed/\n# ai-repo-ops managed files\n.ai/ai-repo-ops.lock.yaml\n",
    );
  });

  it("変更が無い場合はファイルを書き換えない（CRLF を温存する）", async () => {
    const target = path.join(workDir, ".gitignore");
    await writeFile(target, ".ai/runs/\r\n.ai/tmp/\r\n.ai/logs/\r\n");

    const result = await applyAppendUniqueLines(target, [".ai/runs/", ".ai/tmp/", ".ai/logs/"]);
    expect(result.changed).toBe(false);

    // 書き込まれていないので CRLF のまま残る。
    const raw = await readFile(target);
    expect(raw.includes(0x0d)).toBe(true);
  });
});

describe("appendUniqueLinesWithinRoot (safe)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "aro-append-root-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("root 配下の相対 path に通常どおり追記する", async () => {
    const result = await appendUniqueLinesWithinRoot(workDir, ".gitignore", [
      ".ai/runs/",
      ".ai/tmp/",
    ]);
    expect(result.created).toBe(true);
    const content = (await readFile(path.join(workDir, ".gitignore"))).toString("utf8");
    expect(content).toBe(".ai/runs/\n.ai/tmp/\n");
  });

  it("symlink ディレクトリ経由の repo 外書き込みを拒否する（外部ファイルは作られない）", async () => {
    // レビュー指摘の再現: link -> 外部ディレクトリ。link/.gitignore への追記が外部へ漏れないこと。
    const outside = await mkdtemp(path.join(tmpdir(), "aro-outside-"));
    try {
      await symlink(outside, path.join(workDir, "link"), "dir");
      await expect(
        appendUniqueLinesWithinRoot(workDir, "link/.gitignore", ["secret"]),
      ).rejects.toBeInstanceOf(PathSafetyError);
      expect(await readFileIfExists(path.join(outside, ".gitignore"))).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("traversal な相対 path を拒否する", async () => {
    await expect(
      appendUniqueLinesWithinRoot(workDir, "../escape", ["x"]),
    ).rejects.toBeInstanceOf(PathSafetyError);
  });
});
