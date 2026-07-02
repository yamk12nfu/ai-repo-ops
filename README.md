# ai-repo-ops

AI運用基盤の標準装備を、複数のGitHubリポジトリへ安全に配布・更新・検証するための中央管理ツール。

> ステータス: **MVP Phase 6 完了**。`aro init` / `aro diff` / `aro sync` / `aro doctor` はすべて実装済み。残るは Phase 7（docs 拡充）のみ。

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

利用者向けの導入・運用手順（`pnpm link --global` での `aro` 公開、`docs/` への詳細な使い方・復旧手順など）は Phase 7 で拡充する。以下は MVP 時点の最小手順。

## 使い方（MVP）

対象の Git repo に対して次を実行する（`--source` 省略時は実行モジュール位置から `distribution/` を持つ ai-repo-ops source root を上方探索する）。

```bash
aro init --repo /path/to/your-repo     # 初回展開（.ai/ / workflow / lock を生成）
aro diff --repo /path/to/your-repo     # 中央配布物との差分（実ファイルは変更しない）
aro sync --repo /path/to/your-repo     # 中央配布物を適用（conflict があれば一切変更せず abort）
aro doctor --repo /path/to/your-repo   # 対象repoの状態をPASS/WARN/FAILで診断する（読み取り専用）
```

### `aro doctor`

対象 repo が ai-repo-ops に正しく参加できているかを診断する。実ファイルは一切変更しない。

- `.ai/project.yaml` を中央 source の authoritative schema（`schemas/project.schema.json`）で検証する。
- `.ai/managed/**` の checksum を lock file と突き合わせ、人間による直接編集を FAIL として検出する。
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
- MVP ではどちらも npm 配布しない。利用はリポジトリ内（`pnpm aro ...` / `pnpm link --global`）に限る。`pnpm pack` での配布硬化は Phase 7 で扱う。
- 既知の制約: ルートを `pnpm pack` してインストールしても、`bin/aro` が読む `commander` はルートの依存ではないため起動しない（＝ルート単体配布は想定運用外）。パッケージング時には `bin` を `@ai-repo-ops/aro-cli` 側へ寄せる、もしくはルートへ依存を持たせる方針とする。
