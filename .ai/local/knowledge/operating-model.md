# aro の AI 運用モデル（役割と境界）

正本は README.md と docs/ 配下の各文書。本書はそこから導いた索引・要約であり、正本を置き換えない。

## aro とは

- AI 運用基盤の標準装備を、複数の GitHub リポジトリへ安全に配布・更新・検証するための中央管理ツール。
- MVP 完了（Phase 0〜7）+ `aro guard` + Repo Knowledge Loop + Proposal Loop。`aro init` / `aro diff` /
  `aro sync` / `aro doctor` / `aro guard` / `aro knowledge` / `aro proposals check` はすべて実装済み。
- 担当範囲は AI 運用基盤の「配布・更新・診断・強制・根拠付き knowledge 検証」。AI 実行本体は担わない。

## 大原則: AI はローカル、CI は決定的検証

- CI（配布 workflow）に従量課金 API キーの AI を組み込まない。PR レビューは既存サービス（CodeRabbit 等）に任せる。
- v0.1.1 の `ai-review` workflow にあった claude-code-action ベースの AI レビューは廃止済み。現行エンジンは
  `aro guard` と `aro knowledge check`（AI 不要の機械検証）。旧 `anthropic_api_key` 入力は互換性のための
  受け取り口だけが残り、現行エンジンは使用しない。
- コード改善と repo 固有 knowledge の更新は、開発者が手元の Claude Code / Codex で回す
  （docs/local-improve-loop.md、docs/repo-knowledge-loop.md）。
- `ai-improve` workflow は配布物から除去済み（`ai-improve.reusable.yml` は既存 repo の参照を壊さない
  no-op stub のみ）。

## コマンドの要点

- `aro init` — 初回展開（`.ai/` / workflow / lock を生成）。init 後は生成ファイルを一度 commit してから
  次回以降の `aro sync` を実行することを推奨（自動 rollback を持たないため）。
- `aro diff` — 中央配布物との差分表示。実ファイルは変更しない。
- `aro sync` — 中央配布物の適用。conflict があれば一切変更せず abort。更新判定は version ではなく
  canonical checksum が正。
- `aro doctor` — 対象 repo の参加状態を PASS/WARN/FAIL で診断（読み取り専用）。
- `aro guard` — base..HEAD の diff（merge-base 比較）を機械検証。検証ルールは **merge-base 側の
  revision から読む**ため、PR 内で設定を緩めても迂回できない（自己改変防止）。
- `aro knowledge init` — 必須の `--base <ref>` と HEAD の merge-base にある許可設定を読み、`index.yaml` と
  `overview.md` を既存ファイル非上書きで作成。既存 repo は `--base origin/main`、新規 repo は初期 commit
  直後に限り `--base HEAD`。
- `aro knowledge check` — 根拠・provenance・鮮度を検証（読み取り専用）。通常モードは stale を WARN、
  `--strict` は FAIL にする。
- `aro proposals check` — Proposal Loop の提案について frontmatter・採否記録・根拠の鮮度を機械検証
  （読み取り専用）。通常モードは stale を WARN、`--strict` は FAIL にする。

## 開発・配布の前提

- pnpm workspace。`packageManager` フィールドで pnpm に固定し、corepack 経由で利用する。
- 第一級サポートは「中央 repo クローン + `pnpm -C packages/aro-cli link --global`」。repo 内では
  `pnpm aro ...` で実行できる。
- tarball（`pnpm pack`）経由のインストールでは `distribution/` が同梱されないため、配布系コマンドに
  `--source <ai-repo-ops のクローン>` の指定が必須。
- npm public registry への publish は保留（`@ai-repo-ops/aro-cli` は `private: true` のまま）。

## 参照先の索引

- 導入手順と `project.yaml` 調整: docs/onboarding.md
- 配布の仕組み（manifest / lock / hash）: docs/distribution.md、docs/sync-strategy.md
- 安全境界: docs/security.md、docs/guard.md
- ループ運用: docs/local-improve-loop.md、docs/repo-knowledge-loop.md、docs/proposal-loop.md
- Post-MVP 計画: docs/plans/
