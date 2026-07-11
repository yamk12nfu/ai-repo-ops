import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../checksum.js";
import { PathSafetyError } from "../errors.js";
import {
  assertNoSymlinkInPath,
  canonicalSha256OfFile,
  readFileIfExists,
  writeTextFileLf,
  writeTextFileExclusiveWithinRoot,
  writeTextFileWithinRoot,
} from "../filesystem.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "aro-fs-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("writeTextFileLf", () => {
  it("CRLF と先頭 BOM を正規化し、LF・BOM なしで書き込む", async () => {
    const target = path.join(workDir, "nested", "dir", "file.txt");
    await writeTextFileLf(target, "﻿line1\r\nline2\r\n");

    const raw = await readFile(target);
    // BOM bytes(EF BB BF)で始まらない。
    expect(raw[0]).not.toBe(0xef);
    // CR を含まない。
    expect(raw.includes(0x0d)).toBe(false);
    expect(raw.toString("utf8")).toBe("line1\nline2\n");
  });

  it("親ディレクトリが無くても作成して書き込む", async () => {
    const target = path.join(workDir, "a", "b", "c.txt");
    await writeTextFileLf(target, "hello\n");
    expect((await readFile(target)).toString("utf8")).toBe("hello\n");
  });
});

describe("readFileIfExists", () => {
  it("存在しないファイルは null を返す", async () => {
    expect(await readFileIfExists(path.join(workDir, "missing.txt"))).toBeNull();
  });

  it("存在するファイルは Buffer を返す", async () => {
    const target = path.join(workDir, "exists.txt");
    await writeFile(target, "data");
    const buffer = await readFileIfExists(target);
    expect(buffer?.toString("utf8")).toBe("data");
  });
});

describe("canonicalSha256OfFile", () => {
  it("存在しないファイルは null", async () => {
    expect(await canonicalSha256OfFile(path.join(workDir, "missing.txt"))).toBeNull();
  });

  it("ファイル内容の canonical checksum を返す", async () => {
    const target = path.join(workDir, "f.txt");
    await writeFile(target, "a\r\nb\n");
    expect(await canonicalSha256OfFile(target)).toBe(
      canonicalSha256(Buffer.from("a\nb\n", "utf8")),
    );
  });
});

describe("assertNoSymlinkInPath", () => {
  it("通常の（symlink でない）path は通る", async () => {
    await mkdir(path.join(workDir, "real"), { recursive: true });
    await writeFile(path.join(workDir, "real", "file.md"), "x");
    await expect(assertNoSymlinkInPath(workDir, "real/file.md")).resolves.toBeUndefined();
  });

  it("まだ存在しない path も通る（ENOENT で打ち切り）", async () => {
    await expect(
      assertNoSymlinkInPath(workDir, "not-created/yet/file.md"),
    ).resolves.toBeUndefined();
  });

  it("構成要素が symlink の場合は PATH_SYMLINK エラー", async () => {
    await mkdir(path.join(workDir, "real"), { recursive: true });
    await symlink(path.join(workDir, "real"), path.join(workDir, "link"), "dir");

    await expect(assertNoSymlinkInPath(workDir, "link/file.md")).rejects.toBeInstanceOf(
      PathSafetyError,
    );
    await expect(assertNoSymlinkInPath(workDir, "link/file.md")).rejects.toMatchObject({
      code: "PATH_SYMLINK",
    });
  });

  it("最終要素自体が symlink でも検出する", async () => {
    await writeFile(path.join(workDir, "target.md"), "x");
    await symlink(path.join(workDir, "target.md"), path.join(workDir, "alias.md"), "file");
    await expect(assertNoSymlinkInPath(workDir, "alias.md")).rejects.toBeInstanceOf(
      PathSafetyError,
    );
  });
});

describe("writeTextFileWithinRoot", () => {
  it("root 配下に LF・BOM なしで書き込み、絶対 path を返す", async () => {
    const absolute = await writeTextFileWithinRoot(workDir, ".ai/managed/x.md", "﻿a\r\nb\r\n");
    expect(absolute).toBe(path.join(workDir, ".ai", "managed", "x.md"));
    expect((await readFile(absolute)).toString("utf8")).toBe("a\nb\n");
  });

  it("traversal な相対 path を拒否する（書き込まない）", async () => {
    await expect(writeTextFileWithinRoot(workDir, "../escape.md", "x")).rejects.toBeInstanceOf(
      PathSafetyError,
    );
  });

  it("symlink ディレクトリ経由の repo 外書き込みを拒否する", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "aro-outside-"));
    try {
      await symlink(outside, path.join(workDir, "link"), "dir");
      await expect(
        writeTextFileWithinRoot(workDir, "link/escape.md", "secret"),
      ).rejects.toBeInstanceOf(PathSafetyError);
      // 外部ディレクトリにファイルは作られていない。
      expect(await readFileIfExists(path.join(outside, "escape.md"))).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("writeTextFileExclusiveWithinRoot", () => {
  it("存在しないroot配下pathをLF正規化して作成する", async () => {
    const absolute = await writeTextFileExclusiveWithinRoot(workDir, "local/new.md", "a\r\nb\r\n");
    expect(absolute).toBe(path.join(workDir, "local", "new.md"));
    expect(await readFile(absolute, "utf8")).toBe("a\nb\n");
  });

  it("既存ファイルを上書きせずEEXISTにする", async () => {
    const absolute = path.join(workDir, "local", "existing.md");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "original\n");

    await expect(
      writeTextFileExclusiveWithinRoot(workDir, "local/existing.md", "replacement\n"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(absolute, "utf8")).toBe("original\n");
  });

  it("symlink経由の作成を拒否する", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "aro-exclusive-outside-"));
    try {
      await symlink(outside, path.join(workDir, "link"), "dir");
      await expect(
        writeTextFileExclusiveWithinRoot(workDir, "link/new.md", "secret\n"),
      ).rejects.toBeInstanceOf(PathSafetyError);
      expect(await readFileIfExists(path.join(outside, "new.md"))).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
