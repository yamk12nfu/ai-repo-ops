# Changelog

このプロジェクトの注目すべき変更はすべてこのファイルに記録する。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

（`### Known Issues` は Keep a Changelog の標準カテゴリ（Added / Changed / Deprecated / Removed /
Fixed / Security）には無い、このプロジェクトの意図的な拡張。リリース時点で既知の・次のリリースで
解消予定の問題を明示するために使う。）

## [Unreleased]

（次回リリースに向けた変更をここに追記する）

## [0.1.0] - 2026-07-04

MVP（Phase 0〜7）完了時点の初回リリース。「AI 運用基盤の標準装備を複数の GitHub リポジトリへ
配布・更新・診断する」中央管理ツールとしての最小構成が揃った。**この時点では AI 実行本体
（レビュー・改善コメントの自動生成）は未実装であり、配布される reusable workflow は文脈を
echo するだけの stub。** AI 実行の実装は Post-MVP（[計画 02](./docs/plans/02-ai-review-commenter.md) /
[計画 03](./docs/plans/03-guard-and-improve-loop.md)）で行う。

### Added

- `aro init` — 対象 repo に `.ai/project.yaml`・managed files（prompts / policies / schema）・
  `.github/workflows/ai-review.yml` / `ai-improve.yml`・lock file を初回展開する。
- `aro diff` — 中央 distribution と対象 repo の差分を表示する（読み取り専用、`--detailed-exitcode`
  対応）。
- `aro sync` — 中央 distribution の更新を対象 repo に適用する。conflict がある場合は一切変更せず
  abort する。
- `aro doctor` — 対象 repo が ai-repo-ops に正しく参加できているかを PASS/WARN/FAIL で診断する
  （読み取り専用）。
  - `.ai/project.yaml` を authoritative schema（`schemas/project.schema.json`）で検証。
  - `.ai/managed/**` の checksum を lock file と突き合わせ、人間による直接編集は FAIL、
    distribution 更新への追従漏れ・sync 済みファイルの消失は WARN として区別。
  - lock file にあるが現在の manifest に無い managed file を `orphaned` として WARN（自動削除はしない）。
  - `.github/workflows/ai-review.yml` / `ai-improve.yml` の存在・reusable workflow 呼び出し・
    `@main` 参照禁止・`contents:write` permission を検証。
  - `.gitignore` / `.gitattributes` / `.prettierignore` の必要行の有無を検証。
  - 終了コード: `0`=FAIL なし / `1`=FAIL あり / `3`=unexpected error。
- distribution / manifest 機構（`distribution/base/manifest.yaml`）— `files`（`managed_overwrite`）・
  `seed_files`（`create_only`）・`patches`（`append_unique_lines`）・`preserve` を宣言的に記述する
  スキーマと、それを読み込む source loader。
- 更新判定は version ではなく canonical checksum（CRLF・先頭 BOM を無視した正規化テキストのハッシュ）
  を正とする仕組み。path safety（path traversal / symlink 対策）・LF 書き込み・冪等な append ユーティリティ。
- authoritative schema（`schemas/project.schema.json`）と、配布用コピーへの同期・差分チェックスクリプト
  （`pnpm schema:sync` / `pnpm schema:check`）。
- reusable workflow の stub 配布（`ai-review.reusable.yml` / `ai-improve.reusable.yml`）。現時点では
  受け取った `config_path` の存在チェックと echo のみを行う。
- CI（`.github/workflows/ci.yml`）— Node 20 / 24 マトリクスで
  `pnpm install --frozen-lockfile` → `pnpm schema:check` → `pnpm typecheck` → `pnpm build` → `pnpm test`
  を実行。
- ドキュメント一式（`docs/distribution.md` / `docs/sync-strategy.md` / `docs/security.md` /
  `docs/existing-tools.md`）。

### Known Issues

- 配布される `ai-review.yml` / `ai-improve.yml` は `@v1`（moving tag）を参照するが、初回リリースの
  タグ発行までは `v1` タグが存在しないため、`aro init` 済みの対象 repo で workflow が解決エラーになる。
  本リリース（`v0.1.0` タグ発行 + `v1` 移動）で解消する。

[Unreleased]: https://github.com/yamk12nfu/ai-repo-ops/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yamk12nfu/ai-repo-ops/tree/v0.1.0
