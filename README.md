# ai-repo-ops

AI運用基盤の標準装備を、複数のGitHubリポジトリへ安全に配布・更新・検証するための中央管理ツール。

> ステータス: **MVP 完了**（Phase 0〜7）+ `aro guard`（計画 03 Stage 1）。`aro init` / `aro diff` / `aro sync` / `aro doctor` / `aro guard` はすべて実装済み。詳細仕様は [`docs/`](./docs/) を参照。リリース手順は [`RELEASE.md`](./RELEASE.md)、変更履歴は [`CHANGELOG.md`](./CHANGELOG.md) を参照。

AI 実行の方針は「**AI はローカル、CI は決定的検証**」。CI（配布 workflow）に従量課金 API キーの AI を組み込む方向は採らず、PR レビューは既存サービス（CodeRabbit 等）に任せる。`ai-review` workflow（`.github/workflows/ai-review.reusable.yml`）には v0.1.1 時点で claude-code-action ベースの AI レビュー実装があるが、**API キー未登録なら明示 skip されるだけで、dogfooding は行わない**（経緯は [`docs/plans/02-ai-review-commenter.md`](./docs/plans/02-ai-review-commenter.md) 冒頭の注記を参照）。CI のエンジンは `aro guard`（policies の機械的検証。AI 不要）に差し替え済みで、改善ループは開発者が手元の Claude Code で回す（[`docs/local-improve-loop.md`](./docs/local-improve-loop.md)、計画は [`docs/plans/03-guard-and-improve-loop.md`](./docs/plans/03-guard-and-improve-loop.md)）。`ai-improve` workflow（`ai-improve.reusable.yml`）は引き続き echo のみの **stub**。本ツールが担うのは AI 運用基盤の**配布・更新・診断・強制**（`aro init` / `diff` / `sync` / `doctor` / `guard`）である。

## Documentation

- [`docs/distribution.md`](./docs/distribution.md) — manifest / strategy / distribution content hash / authoritative schema
- [`docs/sync-strategy.md`](./docs/sync-strategy.md) — canonical text・checksum・conflict判定・atomicity・コマンド終了コード
- [`docs/security.md`](./docs/security.md) — path traversal / symlink / 固定保護path / workflow permissions
- [`docs/guard.md`](./docs/guard.md) — `aro guard` の検証項目・merge-base 設計（自己改変防止）・CI での利用
- [`docs/local-improve-loop.md`](./docs/local-improve-loop.md) — ローカル改善ループの運用手順（起動・自己検証・PR 規約）
- [`docs/ai-review.md`](./docs/ai-review.md) — v0.1.1 時点の AI レビュー実装記録（方向転換により非推奨。有効化はしない）
- [`docs/existing-tools.md`](./docs/existing-tools.md) — Copier / Cruft との関係、自作する理由、再評価ポイント
- [`docs/plans/`](./docs/plans/) — Post-MVP 計画書（AI 実行本体・fleet 展開など）

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
pnpm schema:sync    # authoritative schema（schemas/project.schema.json）を配布用コピーへ同期
pnpm schema:check   # 上記の差分チェック（CI向け。差分があれば exit 1）
```

## 使い方（MVP）

対象の Git repo に対して次を実行する（`--source` 省略時は実行モジュール位置から `distribution/` を持つ ai-repo-ops source root を上方探索する）。

```bash
aro init --repo /path/to/your-repo     # 初回展開（.ai/ / workflow / lock を生成）
aro diff --repo /path/to/your-repo     # 中央配布物との差分（実ファイルは変更しない）
aro sync --repo /path/to/your-repo     # 中央配布物を適用（conflict があれば一切変更せず abort）
aro doctor --repo /path/to/your-repo   # 対象repoの状態をPASS/WARN/FAILで診断する（読み取り専用）
aro guard --repo /path/to/your-repo --base main   # base..HEAD の diff を policies で機械検証（読み取り専用）
```

### `aro guard`

base と HEAD の diff（merge-base 比較）を `.ai/project.yaml` と適用 policy（`risk_level` に対応する
`.ai/managed/policies/*.yaml`）で機械的に検証する。AI・API キー不要・読み取り専用。

- 検証ルール（`project.yaml` / policy）は **merge-base 側の revision から読む**ため、PR 内で設定を
  緩めても迂回できない。`.ai/project.yaml` 自体の変更は `project_config` violation として必ず表面化する。
- 終了コード: `0`=違反なし / `1`=違反あり / `3`=unexpected error（base に `project.yaml` が無い等）。
- `--json` で違反一覧を機械可読出力。詳細は [`docs/guard.md`](./docs/guard.md) を参照。

### `aro doctor`

対象 repo が ai-repo-ops に正しく参加できているかを診断する。実ファイルは一切変更しない。

- `.ai/project.yaml` を中央 source の authoritative schema（`schemas/project.schema.json`）で検証する。
- `.ai/managed/**` の checksum を lock file と突き合わせる。人間による直接編集（conflict）は FAIL、
  中央 distribution の更新に追従できていない・sync 済みファイルがディスクから消えている状態
  （`aro sync` で自動解消される drift）は WARN として検出する。
- lock file にあるが現在の manifest に無い managed file は `orphaned` として WARN する（MVP では自動削除しない）。
- `.github/workflows/ai-review.yml` / `ai-improve.yml` の存在・reusable workflow 呼び出し・`@main` 参照・`contents:write` permission（`write-all` 省略記法・job-level のpermissionsブロックも含む）をチェックする。
- `.gitignore` / `.gitattributes` / `.prettierignore` に必要行が揃っているかを確認する。
- 終了コード: `0`=FAIL なし / `1`=FAIL あり / `3`=unexpected error（repo path 不正・source 読込失敗など）。

### 更新判定と conflict

- 更新判定は version ではなく canonical checksum を正とする（CRLF / 先頭 BOM だけの差分は conflict にならない）。
- `.ai/managed/**` は直接編集しない。人間が編集して conflict になった場合は `git restore -- <path>` で戻してから `aro sync` する。

### I/O 失敗時の復旧（重要）

MVP の `aro` は**自前の backup/restore（自動 rollback）を持たない**。書き込み中に I/O エラーが起きた場合は、`touched paths`（既存ファイルへの変更）と新規作成ファイルを表示し、手動復旧を案内する。

- **`aro init` 後は、生成されたファイルを一度 git commit してから次回以降の `aro sync` を実行することを推奨する。** 生成ファイルが未 commit のまま I/O 失敗が起きると、`git restore` では復旧できない（git に元の版が無い）ことがある。
- 失敗時は `git status` で touched paths を確認し、既存ファイルは `git restore -- <paths>`、部分生成された新規ファイルは削除（`rm -f <paths>`）してから `aro sync` を再実行する。

## Distribution boundary（MVP）

- ルートパッケージ `ai-repo-ops` は **private な workspace ルート**であり、npm publish / tarball 配布の対象ではない（`private: true` が publish を防ぐ）。
- 配布可能な単位は CLI パッケージ `@ai-repo-ops/aro-cli`（`commander` 依存と実体コードを持ち、`files` で `dist` / `src` のみ同梱）。
- MVP ではどちらも npm 配布しない。利用はリポジトリ内（`pnpm aro ...` / `pnpm link --global`）に限る。`pnpm pack` での配布硬化は MVP 非ゴール（post-MVP で再検討）。
- 既知の制約: ルートを `pnpm pack` してインストールしても、`bin/aro` が読む `commander` はルートの依存ではないため起動しない（＝ルート単体配布は想定運用外）。パッケージング時には `bin` を `@ai-repo-ops/aro-cli` 側へ寄せる、もしくはルートへ依存を持たせる方針とする。
