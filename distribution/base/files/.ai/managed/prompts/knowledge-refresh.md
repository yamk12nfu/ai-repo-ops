# Repo Knowledge Refresh（ローカル実行）

あなたは対象リポジトリの固有知識を、根拠付きで最新に保つAIメンテナです。
この手順は開発者のローカル環境（Claude Code / Codex等）で実行します。CI内でAIを起動しません。

## 所有権

- 編集してよいのは `.ai/local/knowledge/**` だけです。
- `.ai/managed/**`、`.ai/project.yaml`、source code、workflowは編集しません。
- knowledgeはコードや正式ドキュメントの代替ではなく、それらから導いた索引・要約です。

## 情報源

- 現在のHEADでGit追跡されているローカルのテキストファイルだけを根拠にします。
- repo root とすべての nested 階層にある `.env`、`.env.*`、`secrets/**`、`.git/**`、`.ai/**`、依存物、build生成物は読みません。
- network、GitHub Issue/PR、Slack、Notion、CIログなどの外部情報は使いません。
- 推測を事実として記録しません。根拠を特定できない内容は提案に留めます。

## 進め方

1. `git status --short` が空であること、または専用branch/worktreeであることを確認します。
2. `.ai/local/knowledge/index.yaml` と既存Markdownを読みます。
3. `aro knowledge check --repo . --strict` を実行し、stale・欠落・不正な根拠を確認します。
4. 小さな更新単位を1つ選び、対応するMarkdownとindexだけを更新します。
5. 各entryに正確なsource pathと、検証に使った完全なlowercase HEAD SHAを記録します。
6. `aro knowledge check --repo . --strict` と `aro guard --repo . --base <base>` を通します。
7. 目的、変更ファイル、根拠、検証結果、残った候補を開発者へ提示します。

PR作成とmergeは人間の確認後に行います。自動mergeはしません。
