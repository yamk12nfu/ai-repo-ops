import path from "node:path";

import { describe, expect, it } from "vitest";

import { PathSafetyError } from "../errors.js";
import { assertSafeRelativePath, resolveWithinRoot } from "../paths.js";

describe("assertSafeRelativePath", () => {
  it("通常の相対 path を POSIX 区切りに正規化して返す", () => {
    expect(assertSafeRelativePath(".ai/managed/prompts/review.md")).toBe(
      ".ai/managed/prompts/review.md",
    );
  });

  it("先頭の ./ と冗長な区切りを除去する", () => {
    expect(assertSafeRelativePath("./a//b/")).toBe("a/b");
  });

  it("Windows 区切り `\\` を `/` に正規化する", () => {
    expect(assertSafeRelativePath(".github\\workflows\\ai-review.yml")).toBe(
      ".github/workflows/ai-review.yml",
    );
  });

  it("空文字を拒否する", () => {
    expect(() => assertSafeRelativePath("")).toThrowError(PathSafetyError);
  });

  it("`.` のみ（実体なし）を拒否する", () => {
    expect(() => assertSafeRelativePath(".")).toThrowError(PathSafetyError);
  });

  it("`..` を含む path を拒否する", () => {
    expect(() => assertSafeRelativePath("../file")).toThrowError(/PATH_TRAVERSAL|親ディレクトリ/);
    expect(() => assertSafeRelativePath("a/../b")).toThrowError(PathSafetyError);
    expect(() => assertSafeRelativePath(".ai/../../.ssh/config")).toThrowError(PathSafetyError);
  });

  it("POSIX 絶対 path を拒否する", () => {
    expect(() => assertSafeRelativePath("/etc/passwd")).toThrowError(PathSafetyError);
  });

  it("Windows ドライブ付き path を拒否する", () => {
    expect(() => assertSafeRelativePath("C:\\Windows\\system32")).toThrowError(PathSafetyError);
    expect(() => assertSafeRelativePath("C:relative")).toThrowError(PathSafetyError);
  });

  it("UNC path を拒否する", () => {
    // `\\host\share` は `/` 正規化後に `//host/share` となり絶対扱いで拒否される。
    expect(() => assertSafeRelativePath("\\\\host\\share\\x")).toThrowError(PathSafetyError);
  });

  it("NUL 文字を含む path を拒否する", () => {
    expect(() => assertSafeRelativePath("a\0b")).toThrowError(/PATH_NUL|NUL/);
  });

  it("末尾空白付き `..`（Win32 が `..` に正規化する）を traversal として拒否する", () => {
    // Windows は末尾の空白/ドットを strip するため ".. " はカーネルで ".." に化け、親へ脱出しうる。
    expect(() => assertSafeRelativePath(".. ")).toThrowError(PathSafetyError);
    expect(() => assertSafeRelativePath("a/.. /b")).toThrowError(PathSafetyError);
    try {
      assertSafeRelativePath(".. ");
      expect.unreachable("例外が投げられるべき");
    } catch (error) {
      expect((error as PathSafetyError).code).toBe("PATH_TRAVERSAL");
    }
  });

  it("ドット/空白のみのセグメント（`...` 等）を拒否する", () => {
    expect(() => assertSafeRelativePath("...")).toThrowError(PathSafetyError);
    expect(() => assertSafeRelativePath("a/ /b")).toThrowError(PathSafetyError);
  });

  it("末尾が `.` または空白のセグメント（Win32 で別名になる）を拒否する", () => {
    // file. / file （末尾空白）/ name.  は Windows で file / name に化け、dest と実ファイルの対応が崩れる。
    for (const p of ["file.", "file ", "dir/name. ", "review.md ", "a/b./c"]) {
      expect(() => assertSafeRelativePath(p)).toThrowError(PathSafetyError);
    }
    try {
      assertSafeRelativePath("file.");
      expect.unreachable("例外が投げられるべき");
    } catch (error) {
      expect((error as PathSafetyError).code).toBe("PATH_RESERVED");
    }
  });

  it("NTFS 代替データストリーム構文（コロンを含むセグメント）を拒否する", () => {
    expect(() => assertSafeRelativePath("file.txt:evil")).toThrowError(/PATH_RESERVED|コロン/);
    try {
      assertSafeRelativePath("dir/file.txt:stream");
      expect.unreachable("例外が投げられるべき");
    } catch (error) {
      expect((error as PathSafetyError).code).toBe("PATH_RESERVED");
    }
  });

  it("Windows 予約デバイス名（拡張子有無を問わず）を拒否する", () => {
    for (const name of ["NUL", "con", "AUX", "com1", "LPT9", "sub/PRN", "nul.md", "Aux.txt"]) {
      expect(() => assertSafeRelativePath(name)).toThrowError(PathSafetyError);
    }
    try {
      assertSafeRelativePath("NUL");
      expect.unreachable("例外が投げられるべき");
    } catch (error) {
      expect((error as PathSafetyError).code).toBe("PATH_RESERVED");
    }
  });

  it("予約名に紛れない通常の path は受理する（過剰拒否しない）", () => {
    // 先頭ドット・予約名を部分に含むだけのファイルは正当。
    expect(assertSafeRelativePath(".gitignore")).toBe(".gitignore");
    expect(assertSafeRelativePath(".github/workflows/ai-improve.yml")).toBe(
      ".github/workflows/ai-improve.yml",
    );
    expect(assertSafeRelativePath("console.md")).toBe("console.md"); // CON で始まるが CON ではない
    expect(assertSafeRelativePath("a..b/c")).toBe("a..b/c"); // ドットを含むが全体がドットではない
    expect(assertSafeRelativePath("nullable.ts")).toBe("nullable.ts"); // NUL を含むが NUL ではない
  });

  it("拒否時のエラーは code と offendingPath を持つ", () => {
    try {
      assertSafeRelativePath("../escape");
      expect.unreachable("例外が投げられるべき");
    } catch (error) {
      expect(error).toBeInstanceOf(PathSafetyError);
      const safetyError = error as PathSafetyError;
      expect(safetyError.code).toBe("PATH_TRAVERSAL");
      expect(safetyError.offendingPath).toBe("../escape");
    }
  });
});

describe("resolveWithinRoot", () => {
  const root = path.resolve("/tmp/example-repo");

  it("root 配下の絶対 path を返す", () => {
    expect(resolveWithinRoot(root, ".ai/project.yaml")).toBe(
      path.join(root, ".ai", "project.yaml"),
    );
  });

  it("`..` を含む相対 path を拒否する（文字列段階で弾く）", () => {
    expect(() => resolveWithinRoot(root, "../outside")).toThrowError(PathSafetyError);
  });

  it("絶対 path を拒否する", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrowError(PathSafetyError);
  });
});
