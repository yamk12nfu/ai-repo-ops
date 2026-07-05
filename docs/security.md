# Security

`ai-repo-ops` は複数の外部 repo に対してファイルを書き込むツールであるため、manifest（信頼できるはずの中央 source だが将来 fork/PR で改変されうる）と対象 repo（CLI 利用者が任意の path を渡せる）の両方を信頼しない前提で防御する。このドキュメントは実装済みの安全対策をまとめる。実装は主に `packages/aro-cli/src/core/paths.ts`・`filesystem.ts`・`manifest.ts` にある。

## path traversal 防止

manifest の `files[].src` / `files[].dest` / `seed_files[].dest` / `seed_files[].src` / `seed_files[].template` / `patches[].path`、および lock file 内の path はすべて `assertSafeRelativePath` を通す。

拒否する入力:

```txt
空文字
絶対 path（/abs, C:\x, \\host\share）
.. を含む path（a/../b, ..）
末尾が「.」または空白だけのセグメント（".. " のような Windows 由来の別名化を防ぐ）
NUL 文字を含む path
コロンを含むセグメント（file.txt:stream などの NTFS 代替データストリーム）
Windows 予約デバイス名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9、拡張子の有無を問わず）
```

Windows 由来の `\` 区切りも区切り文字として扱い、OS 非依存に検証する。安全と判定された path は POSIX 区切りに正規化して返す（`./a/b` → `a/b`、`a\b` → `a/b`）。

検証後さらに `resolveWithinRoot` で、解決した絶対 path が基準ディレクトリ（対象 repo root または distribution root）の内側に収まることを再確認する（defense in depth）。

## symlink

MVP では symlink を一切追従しない。

```txt
対象 path または親 path のいずれかに symlink があれば error
source distribution 内の symlink も error
```

`readFileWithinRoot` / `assertNoSymlinkInPath` が path の各構成要素を検査し、symlink が含まれていれば読み書き前に拒否する。これにより、symlink を経由した repo 外への書き込みや、意図しないファイルの読み取りを防ぐ。

## 固定保護 path（preserve）

以下の path は manifest の `preserve[]` 指定の有無に関わらず、`files[]`（`managed_overwrite`）・`seed_files[]`（`create_only`）・`patches[]`（`append_unique_lines`）のいずれの対象にもできない（`ALWAYS_PRESERVED_PATTERNS`、manifest 検証エラーとして拒否される）。

```txt
.env
.env.*
secrets/**
.ai/local/**
.git/**
```

`.ai/project.yaml` だけは唯一の例外で、上記とは別に `managed_overwrite` / `patches[]` 対象から禁止されつつ、`seed_files[]`（`create_only`）としてのみ配布を許可する（初回だけ生成し、以後は repo 固有設定として保護する）。

これらは manifest 作者が明示的な `preserve[]` を書き忘れても効く安全網であり、`aro` 自身が信頼できない manifest（改変された distribution）を渡された場合でも、secrets や `.git/` 内部への書き込みを防ぐ最終防壁として機能する。

さらに `preserve[]`（manifest 作者が任意に追加できる glob）に一致する path は `files[].dest` にできない。glob マッチングは `picomatch`（`dot: true, nocase: true`）で行い、大文字小文字を区別しない — macOS(APFS) / Windows(NTFS) のような case-insensitive なファイルシステムで `.ENV` が `.env` に解決されてしまうケースを、保護側に倒して弾くため。

manifest 内の配布先 path（`files[].dest` / `seed_files[].dest` / `patches[].path`）は全体で一意でなければならない（大文字小文字を区別しない）。重複を許すと `apply` が dest をキーに source 内容を join する際に last-wins で内容が静かに失われ、lock と実ファイルが食い違うため。

## UTF-8 検証

manifest が参照する `src` / `template` ファイル、および authoritative schema（`schemas/project.schema.json`）は、`TextDecoder("utf-8", { fatal: true })` で厳密に UTF-8 として decode できることを確認する。`Buffer#toString("utf8")` は不正なバイト列を置換文字（U+FFFD）へ静かに握りつぶすため、これでは壊れた配布ファイルを検出できない。fatal decode に失敗した場合は `SOURCE_FILE_NOT_UTF8` エラーとして拒否する。binary file の配布は MVP では対応しない。

## distribution 名の検証

`--distribution` は CLI から渡される untrusted な文字列であり、そのまま `path.join` すると `../...` で `distribution/` の外側を指せてしまう。`assertValidDistributionName` により、英数字・`.`・`_`・`-` のみで構成される単一セグメント（先頭ドット不可）だけを許可する。

## GitHub Actions workflow の permissions

配布する workflow は permissions を明示する。

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
```

`ai-review` workflow は `contents: write` を持つべきではない（`aro doctor` が top-level / job 単位いずれの permissions でも `contents: write` あるいは `write-all` を検出すると **FAIL** にする）。`ai-improve` workflow は PR 作成のために `contents: write` を持つ想定だが、main への直接 push は禁止する運用前提とし、`aro doctor` では **WARN** に留める。

> **方向転換（2026-07-05）**: `ai-improve` の `contents: write` は「CI 内で AI が改善 PR を自動作成する」旧設計の名残である。現行の reusable workflow は stub（echo のみ）で実書き込みは行わないが、現方針では CI 内で AI を実行しない（改善ループは開発者のローカル環境で回す。[計画 03](./plans/03-guard-and-improve-loop.md) 参照）ため、この権限は不要になる。計画 03 Stage 2-2 で配布物からの除去・権限の縮小・`aro doctor` の WARN 判定の見直しをセットで行う。

`id-token: write` は旧エンジン（`claude-code-action`）の既定認証（OIDC）向けに配布側 `ai-review.yml` に付与していたもの。guard エンジンへの差し替え（計画 03 Stage 1-2）後の reusable workflow は要求しない（callee が要求しない permission は caller にあっても使われないため、配布済み repo に残っていても無害）。`aro doctor` の permissions チェックは `contents` の値（および `write-all` shorthand）のみを見るため、`id-token: write` の有無は PASS/WARN/FAIL の判定に影響しない。

`aro doctor` は次も検査する。

```txt
workflow file の存在
central reusable workflow（yamk12nfu/ai-repo-ops/.github/workflows/<file>）を owner/repo/path で厳密一致呼び出ししているか
@ref（tag/branch/SHA）が付いているか（付いていない他リポジトリ reusable workflow 呼び出しは GitHub 側が invalid として拒否するため FAIL）
中央 workflow への参照が @main に固定されている場合は WARN（安定した @v1 等のタグを推奨）
```

## secret / token

`ai-review` の reusable workflow（`ai-review.reusable.yml`）は `workflow_call.secrets.anthropic_api_key` を明示的に受け取る（`required: false`。未設定なら実行時 gate で明示 skip）。配布側 `ai-review.yml` も `secrets: { anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }} }` のように明示的に渡しており、`secrets: inherit` は使わない方針を維持している（`ai-repo-ops-implementation-plan-v3.md` §20.5）。

fork PR には GitHub の仕様上 secrets が渡らないため、AI レビューは明示的に skip される（workflow 自体は成功する）。詳細は [`ai-review.md`](./ai-review.md) を参照。

> **方向転換（2026-07-05）**: 現方針では対象 repo に `ANTHROPIC_API_KEY` を登録する運用は行わない（CI 内で AI を実行しないため。[計画 02 の注記](./plans/02-ai-review-commenter.md) 参照）。secrets の受け取り口（`anthropic_api_key`）は reusable workflow の互換性契約として残るが、計画 03 Stage 1-2 の guard エンジンへの差し替え以降は使用されない。

## managed file 誤編集からの復旧

`.ai/managed/**` は直接編集禁止。人間が編集すると checksum mismatch として conflict（`aro diff` / `aro sync`）または FAIL（`aro doctor`）になる。復旧手順は以下のみで、`aro reset-managed` のような専用コマンドは実装しない。

```bash
git restore -- .ai/managed/<path>
aro sync --repo .
```
