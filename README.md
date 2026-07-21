# ai-repo-ops

AI運用基盤の標準装備を、複数のGitHubリポジトリへ安全に配布・更新・検証するための中央管理ツール。

> ステータス: **MVP 完了**（Phase 0〜7）+ `aro guard` + Repo Knowledge Loop。`aro init` / `aro diff` / `aro sync` / `aro doctor` / `aro guard` / `aro knowledge` はすべて実装済み。詳細仕様は [`docs/`](./docs/) を参照。リリース手順は [`RELEASE.md`](./RELEASE.md)、変更履歴は [`CHANGELOG.md`](./CHANGELOG.md) を参照。

AI 実行の方針は「**AI はローカル、CI は決定的検証**」。CI（配布 workflow）に従量課金 API キーの AI を組み込む方向は採らず、PR レビューは既存サービス（CodeRabbit 等）に任せる。v0.1.1 の `ai-review` workflow にあった claude-code-action ベースの AI レビューは廃止し、現在のエンジンは `aro guard` と `aro knowledge check`（AI 不要の機械検証）へ差し替え済み。旧 `anthropic_api_key` 入力は互換性のため受け取り口だけ残しているが、現行エンジンは使用せず登録も不要である（経緯は [`docs/plans/02-ai-review-commenter.md`](./docs/plans/02-ai-review-commenter.md) 冒頭の注記を参照）。コード改善と repo 固有knowledgeの更新は開発者が手元の Claude Code / Codex で回す（[`docs/local-improve-loop.md`](./docs/local-improve-loop.md)、[`docs/repo-knowledge-loop.md`](./docs/repo-knowledge-loop.md)）。`ai-improve` workflow は計画 03 Stage 2-2 で**配布物から除去済み**（`ai-improve.reusable.yml` は既存 repo の参照を壊さない no-op stub のみ）。本ツールが担うのは AI 運用基盤の**配布・更新・診断・強制・根拠付きknowledge検証**である。

## Documentation

- [`docs/onboarding.md`](./docs/onboarding.md) — 対象 repo への導入手順と init 後の `project.yaml` 調整（事実上必須）・override merge の運用
- [`docs/distribution.md`](./docs/distribution.md) — manifest / strategy / distribution content hash / authoritative schema
- [`docs/sync-strategy.md`](./docs/sync-strategy.md) — canonical text・checksum・conflict判定・atomicity・コマンド終了コード
- [`docs/security.md`](./docs/security.md) — path traversal / symlink / 固定保護path / workflow permissions
- [`docs/guard.md`](./docs/guard.md) — `aro guard` の検証項目・merge-base 設計（自己改変防止）・CI での利用
- [`docs/repo-knowledge-loop.md`](./docs/repo-knowledge-loop.md) — repo固有knowledgeの形式・鮮度・安全境界・導入手順
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
pnpm schema:sync    # authoritative schemas（project / knowledge）を配布用コピーへ同期
pnpm schema:check   # 上記2 schemaの差分チェック（CI向け。差分があれば exit 1）
```

## 使い方（MVP）

対象の Git repo に対して次を実行する（`--source` 省略時は実行モジュール位置から `distribution/` を持つ ai-repo-ops source root を上方探索する）。

`aro` コマンドをグローバルに使えるようにするには（推奨。要: `pnpm setup` 済みで `PNPM_HOME` が PATH にあること）:

```bash
pnpm build
pnpm -C packages/aro-cli link --global   # 以後、任意のディレクトリで aro が使える
```

`aro` が PATH にない、または一時的に使うだけなら、global link は不要。中央 repo を一度 build し、
Node entrypoint を直接実行する。

```bash
# 初回準備（中央 repo 内）
cd /path/to/ai-repo-ops
corepack pnpm install
corepack pnpm build

# 以後は任意のディレクトリから実行可能
node /path/to/ai-repo-ops/packages/aro-cli/bin/aro --help
node /path/to/ai-repo-ops/packages/aro-cli/bin/aro knowledge init \
  --repo /path/to/your-repo \
  --base origin/main
```

`knowledge init` の成功出力は、実際に使ったNode entrypoint、対象repoの絶対path、検証済みbase SHAを
後続の `knowledge check` / `guard` とローカルAIへ貼るプロンプトに引き継ぐ。`aro` がPATHになくても、
別directoryから初期化しても、表示された内容をそのまま使える。

```bash
aro init --repo /path/to/your-repo     # 初回展開（.ai/ / workflow / lock を生成）
aro diff --repo /path/to/your-repo     # 中央配布物との差分（実ファイルは変更しない）
aro sync --repo /path/to/your-repo     # 中央配布物を適用（conflict があれば一切変更せず abort）
aro doctor --repo /path/to/your-repo   # 対象repoの状態をPASS/WARN/FAILで診断する（読み取り専用）
aro guard --repo /path/to/your-repo --base main   # base..HEAD の diff を policies で機械検証（読み取り専用）
aro knowledge init --repo /path/to/your-repo --base origin/main  # merge済み設定を基準にknowledge領域を初期化
aro knowledge check --repo /path/to/your-repo     # 根拠・provenance・鮮度を検証（読み取り専用）
```

### `aro knowledge`

`.ai/local/knowledge/` に、コード・正式ドキュメントから導いた repo 固有の索引と要約を置く。
knowledge は正本ではなく、各 entry が正確な source path と検証済み Git commit を持つ。

- `aro knowledge init` は必須の `--base <ref>` と HEAD の merge-base にある許可設定を読み、`index.yaml` と
  `overview.md` を既存ファイル非上書きで作成する。既存 repo は `--base origin/main`、新規 repo は
  `aro init` の初期 commit 直後に限り `--base HEAD` を使う。
- 2ファイルの作成途中で I/O error が起きた場合は、作成済み path と削除対象を表示して exit `3` にする。
- `aro knowledge check` は通常モードで stale を WARN / exit 0、`--strict` では FAIL / exit 1 にする。
- 既存 repo は `.ai/project.yaml` に `.ai/local/knowledge/**` を追加する設定専用 PR を先に merge する。
- source は Git 追跡済み UTF-8 text の正確な相対 path に限定し、secret・`.git`・`.ai`・依存物・
  build生成物・symlink・glob を拒否する。
- CI は index のある repo だけ検証し、knowledge を変更する PR では strict にする。AI API・外部network・
  自動PR / mergeは使わない。

詳細は [`docs/repo-knowledge-loop.md`](./docs/repo-knowledge-loop.md) を参照。

### `aro guard`

base と HEAD の diff（merge-base 比較）を `.ai/project.yaml` と適用 policy（`risk_level` に対応する
`.ai/managed/policies/*.yaml`）で機械的に検証する。AI・API キー不要・読み取り専用。

- 検証ルール（`project.yaml` / policy）は **merge-base 側の revision から読む**ため、PR 内で設定を
  緩めても迂回できない。`.ai/project.yaml` 自体の変更は `project_config` violation として必ず表面化する。
- lock変更を含むPRでは、merge-baseの対象fileへ中央distributionのsyncを再実行し、HEADのraw bytes・
  Git modeと完全一致するbundleだけをtrusted syncとして認証する。認証pathは`managed_file`と
  `outside_allowed_paths`だけを免除し、forbidden/workflow/project_config/change limitsは維持する。
- 終了コード: `0`=違反なし / `1`=違反あり / `3`=unexpected error（base に `project.yaml` が無い等）。
- `--json` で違反一覧を機械可読出力。詳細は [`docs/guard.md`](./docs/guard.md) を参照。

### `aro doctor`

対象 repo が ai-repo-ops に正しく参加できているかを診断する。実ファイルは一切変更しない。

- `.ai/project.yaml` を中央 source の authoritative schema（`schemas/project.schema.json`）で検証する。
- `.ai/managed/**` の checksum を lock file と突き合わせる。人間による直接編集（conflict）は FAIL、
  中央 distribution の更新に追従できていない・sync 済みファイルがディスクから消えている状態
  （`aro sync` で自動解消される drift）は WARN として検出する。
- lock file にあるが現在の manifest に無い managed file は `orphaned` として WARN する（MVP では自動削除しない）。
- lock の distribution content hash が中央 source とずれていれば WARN する（seed の配布終了のように
  実ファイル差分を生まない配布変更でも `aro sync` による lock 更新が必要なことを検出する）。
- `.github/workflows/ai-review.yml` の存在・reusable workflow 呼び出し・`@main` 参照・`contents:write` permission（`write-all` 省略記法・job-level のpermissionsブロックも含む）をチェックする。
- 配布終了済みの `.github/workflows/ai-improve.yml`（legacy seed）が残っていれば WARN として手動削除を案内する（`create_only` のため `aro sync` では消えない）。
- `.gitignore` / `.gitattributes` / `.prettierignore` に必要行が揃っているかを確認する。
- 終了コード: `0`=FAIL なし / `1`=FAIL あり / `3`=unexpected error（repo path 不正・source 読込失敗など）。

### 更新判定と conflict

- 更新判定は version ではなく canonical checksum を正とする（CRLF / 先頭 BOM だけの差分は conflict にならない）。
- `.ai/managed/**` は直接編集しない。人間が編集して conflict になった場合は `git restore -- <path>` で戻してから `aro sync` する。

### I/O 失敗時の復旧（重要）

MVP の `aro` は**自前の backup/restore（自動 rollback）を持たない**。書き込み中に I/O エラーが起きた場合は、`touched paths`（既存ファイルへの変更）と新規作成ファイルを表示し、手動復旧を案内する。

- **`aro init` 後は、生成されたファイルを一度 git commit してから次回以降の `aro sync` を実行することを推奨する。** 生成ファイルが未 commit のまま I/O 失敗が起きると、`git restore` では復旧できない（git に元の版が無い）ことがある。
- 失敗時は `git status` で touched paths を確認し、既存ファイルは `git restore -- <paths>`、部分生成された新規ファイルは削除（`rm -f <paths>`）してから `aro sync` を再実行する。

## Distribution boundary

- **第一級サポートは「中央 repo クローン + `pnpm link --global`」**（[計画 04](./docs/plans/04-packaging.md)）。
  `bin` は `@ai-repo-ops/aro-cli` にあり（`packages/aro-cli/bin/aro`）、link 経由なら実体が workspace 内に
  留まるため `distribution/` の上方探索がそのまま機能する（`--source` 不要）。
- `pnpm -C packages/aro-cli pack` した tarball からのインストールでも `aro` は起動する（依存は
  aro-cli 側にあるため解決される）。ただし `distribution/` が同梱されないので、`init` / `diff` /
  `sync` / `doctor` / `knowledge init` / `knowledge check` には
  **`--source <ai-repo-ops のクローン>` の指定が必須**（未指定時は上方探索の
  失敗として `--source` の案内つきエラーになる）。この経路は CI の pack smoke test が毎 PR で検証する。
- ルートパッケージ `ai-repo-ops` は private な workspace ルートで、配布単位ではない。
  `pnpm aro ...`（repo 内実行）は従来どおり使える。
- npm public registry への publish は保留（`@ai-repo-ops/aro-cli` は `private: true` のまま。
  publish に進む場合の distribution content の扱いは fleet の運用実績を見て判断する）。
