# ai-repo-ops

AI運用基盤の標準装備を、複数のGitHubリポジトリへ安全に配布・更新・検証するための中央管理ツール。

> ステータス: **Phase 0（リポジトリ初期化）**。CLI コマンド本体（`init` / `diff` / `sync` / `doctor`）は後続フェーズで実装する。現状は scaffold と各コマンドの stub のみ。

## Development

このリポジトリは pnpm workspace。パッケージマネージャは `packageManager` フィールドで pnpm に固定し、corepack 経由で利用する。

```bash
# pnpm を有効化（pnpm 未インストール環境ではこの一手が必要）
corepack enable

pnpm install        # 依存をインストール
pnpm build          # 全パッケージを tsc でビルド
pnpm typecheck      # 型検査（テストファイルも含む）
pnpm test           # vitest
pnpm aro --help     # aro CLI のヘルプ（事前に pnpm build が必要）
```

利用者向けの導入・運用手順（`pnpm link --global` での `aro` 公開、各コマンドの使い方、復旧手順など）は Phase 7 で README / `docs/` に拡充する。

## Distribution boundary（MVP）

- ルートパッケージ `ai-repo-ops` は **private な workspace ルート**であり、npm publish / tarball 配布の対象ではない（`private: true` が publish を防ぐ）。
- 配布可能な単位は CLI パッケージ `@ai-repo-ops/aro-cli`（`commander` 依存と実体コードを持ち、`files` で `dist` / `src` のみ同梱）。
- MVP ではどちらも npm 配布しない。利用はリポジトリ内（`pnpm aro ...` / `pnpm link --global`）に限る。`pnpm pack` での配布硬化は Phase 7 で扱う。
- 既知の制約: ルートを `pnpm pack` してインストールしても、`bin/aro` が読む `commander` はルートの依存ではないため起動しない（＝ルート単体配布は想定運用外）。パッケージング時には `bin` を `@ai-repo-ops/aro-cli` 側へ寄せる、もしくはルートへ依存を持たせる方針とする。
