# Changelog

このプロジェクトの注目すべき変更はすべてこのファイルに記録する。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

（`### Known Issues` は Keep a Changelog の標準カテゴリ（Added / Changed / Deprecated / Removed /
Fixed / Security）には無い、このプロジェクトの意図的な拡張。リリース時点で既知の・次のリリースで
解消予定の問題を明示するために使う。）

## [Unreleased]

### Added

- `aro guard` — base と HEAD の diff（merge-base 比較）を `.ai/project.yaml` と適用 policy で機械的に
  検証する読み取り専用コマンド（[計画 03](./docs/plans/03-guard-and-improve-loop.md) Stage 1-1）。
  - 検証項目: forbidden_paths（project.yaml ∪ policy）/ managed files / workflows /
    `.ai/project.yaml` 自体の変更（`project_config`）/ allowed_paths / change_limits。
  - 検証ルールは **merge-base 側の revision から読む**（PR 内で設定を緩めて自身の検証を
    骨抜きにする迂回を防止）。`risk_level` → policy の対応を TypeScript 側に正式実装。
  - 終了コード `0`（違反なし）/ `1`（違反あり）/ `3`（unexpected）、`--json` 出力対応。
  - 詳細は [`docs/guard.md`](./docs/guard.md)。

### Changed

- **AI 実行方針の転換**（docs のみ。コード・配布物の変更なし）: CI で従量課金 API キーの AI を
  動かす方式・secrets を repo ごとに配る運用・自前レビュー基盤を採らないことを確定。
  計画 02 の dogfooding を中止し（v0.1.1 の AI レビューは API キー未登録なら skip のため無害）、
  計画 03 を「`aro guard`（CI は AI なしの決定的検証）+ ローカル改善ループ（AI は開発者の手元で実行）」
  に再設計。`docs/plans/02` / `docs/plans/03` / `docs/plans/README.md` / `docs/ai-review.md` /
  `README.md` を改訂。
- CLI の `--version`（`ARO_CLI_VERSION`）を package.json の `0.1.1` に一致させた（従来 `0.1.0` の
  ままズレていた）。
- `ai-review.reusable.yml` のエンジンを claude-code-action（AI レビュー）から `aro guard` に差し替えた
  （計画 03 Stage 1-2）。互換性契約（inputs / secrets 名）は維持しており、**対象 repo 側の変更・sync は
  不要**（リリース時の `v1` タグ移動で全対象 repo が guard ベースの CI に切り替わる）。
  - guard は secrets 不要のため fork PR でも実行される（旧エンジンの fork skip は廃止）。
  - 違反時は job が fail し、違反一覧が step summary と PR コメントに出る。base に検証ルールが
    無い場合（導入 PR 等）は明示 skip で workflow は成功する。
  - reusable workflow の permissions から `id-token: write`（旧エンジンの OIDC 用）と
    `issues: write` を除いた。secrets の受け取り口（`anthropic_api_key`）は互換性契約として
    残るが使用しない。

## [0.1.1] - 2026-07-05

AI レビューコメンターの実装（[計画 02](./docs/plans/02-ai-review-commenter.md)）。参加 repo で PR を
開くと AI レビューコメントが自動で付くようになった（`ai-improve` は引き続き stub）。

### Added

- `docs/ai-review.md` — AI レビューコメンターのアーキテクチャ・有効化手順・既存 repo への移行手順・
  レビューの挙動（risk_level → policy マッピング）・セキュリティ設計をまとめたドキュメント。

### Changed

- `ai-review.reusable.yml` を stub から実実装に置き換えた（[計画 02](./docs/plans/02-ai-review-commenter.md)）。
  - AI エンジンとして `anthropics/claude-code-action@v1` を使用し、read-only（`--allowedTools` を
    `Read` / `Glob` / `Grep` / `gh pr comment` 等の閲覧・コメント系コマンドに限定し、
    `Edit,Write,MultiEdit,NotebookEdit,WebSearch,WebFetch` を明示禁止）でレビューし、結果を PR コメント
    として投稿する。
  - `.ai/project.yaml` の `project.risk_level` に応じて適用 policy（`low-risk.yaml` /
    `default.yaml` / `security.yaml`）を切り替え、`review.md` の観点をプロンプトに含める。
  - fork PR（head repo ≠ base repo）と `ANTHROPIC_API_KEY` 未設定時は明示的に skip し、workflow は
    成功したまま理由を step summary に出力する。`pull_request_target` は使わない。
  - AI レビュー step は `continue-on-error: true` とし、失敗しても PR を block しない
    （required check にはしない）。
  - permissions に `id-token: write` を追加（AI レビューエンジンの既定 OIDC 認証に必要。
    `contents: write` は引き続き付与しない）。
  - `workflow_call.secrets.anthropic_api_key` は後方互換のため `required: false`
    （既存配布版の caller には secrets ブロックが無いため）とし、実行時に未設定を検知して skip する。
- 配布側 `distribution/base/files/.github/workflows/ai-review.yml` に
  `secrets: { anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }} }` と `permissions.id-token: write` を追記
  （`secrets: inherit` は使わない方針を維持）。
- `distribution/base/manifest.yaml` の `version` を `0.1.0` → `0.1.1` に bump。

### Known Issues

- `.github/workflows/ai-review.yml` は manifest 上 `create_only`（seed file）戦略のため、**すでに
  `aro init` 済みの対象 repo には `aro sync` で自動反映されない**。既存 repo で secrets /
  `id-token: write` を反映するには、(a) 該当ファイルへ手動で追記する、または (b) ファイルを削除して
  `aro sync` を再実行する（`create_only` は存在しなければ作成するため最新版が再展開される）、
  のいずれかが必要。詳細は [`docs/ai-review.md`](./docs/ai-review.md) を参照。

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

[Unreleased]: https://github.com/yamk12nfu/ai-repo-ops/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/yamk12nfu/ai-repo-ops/tree/v0.1.1
[0.1.0]: https://github.com/yamk12nfu/ai-repo-ops/tree/v0.1.0
