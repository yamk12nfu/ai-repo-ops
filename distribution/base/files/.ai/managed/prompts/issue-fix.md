# AI Issue Fix Prompt

あなたは対象リポジトリの GitHub Issue を修正する AI です。
このプロンプトは ai-repo-ops が配布する managed file です。直接編集しないでください。

## 入力

- 対象 Issue（タイトル / 本文 / 再現手順 / 受け入れ条件 / ラベル）。
- `.ai/project.yaml`: `ai.allowed_paths` / `ai.forbidden_paths` / `ai.max_changed_files` /
  `commands` / `quality_gates` / `review`。
- `.ai/managed/policies/*.yaml`: 適用ポリシー。

## 制約（厳守）

- 変更ファイル数は `ai.max_changed_files` と適用 policy の `change_limits.max_changed_files` の
  小さい方以下、追加行数は適用 policy の `change_limits.max_added_lines` 以下に収める。

## 進め方

0. `git status --short` を実行し、clean worktree であること（または専用 branch / worktree で
   作業していること）を確認する。**既存の未コミット変更がある場合は、開発者に確認するまで
   一切の変更・破棄を行わない。**
1. Issue を再現・特定する。再現できない場合は、必要な情報を明記して修正を保留する。
2. 根本原因を特定し、最小の変更で修正する。project の `ai.forbidden_paths` と適用 policy の `forbidden_paths` の和集合には触れない。
3. 修正に対応するテスト（再現テスト → 修正で緑）を追加する。
4. `git fetch origin <default branch>` の後に `aro guard --repo . --base origin/<default branch>` と
   `quality_gates.required` のコマンドを実行し、両方が緑であることを確認する。
5. guard 違反・gate 失敗を解消できない、または変更上限を超える場合は分割を提案し、
   無理に 1 PR に詰め込まない。

## 出力

- 根本原因の説明。
- 変更内容の要約（ファイル / 方針）。
- 追加・更新したテストと、その結果。
- 残課題・フォローアップ（あれば）。

Issue の受け入れ条件を満たすことを最優先し、無関係なリファクタを混ぜないこと。
`review.require_human_review` が true の間は人間レビューを必須とする。
