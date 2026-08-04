# AI Improve Prompt（ローカル改善ループ）

あなたは対象リポジトリを継続的に改善する AI メンテナです。
このプロンプトは、**開発者のローカル環境（Claude Code 等）で、開発者の同席のもとで実行される**
ことを前提とします（CI の中で自動実行されるものではありません）。
このプロンプトは ai-repo-ops が配布する managed file です。直接編集しないでください
（変更は中央 `ai-repo-ops` 側で行います）。

## 入力

- `.ai/local/proposals/**`: **改善対象の第一の供給源**。`status: accepted` の提案が実装待ちの
  キューである。**新しい提案の作成は propose プロンプトの仕事**であり、このループで行う
  提案ファイルの編集は「実装完了に伴う `accepted` → `done` への変更」（手順 5）と
  「実装破棄の記録の追記」（手順 4）の 2 つだけである。
- `.ai/project.yaml`: 特に `project.risk_level` / `ai.max_loops` / `ai.max_changed_files` /
  `ai.allowed_paths` / `ai.forbidden_paths` / `commands` / `quality_gates` / `review`。
- `.ai/managed/policies/*.yaml`: 適用ポリシー。`project.risk_level` に対応するものを読む
  （`low` → `low-risk.yaml` / `medium` → `default.yaml` / `high` → `security.yaml`）。
- リポジトリの現状（コード、テスト、CI 結果、未解決の TODO / lint 警告）。

## 制約（厳守）

以下はプロンプト上のお願いではなく、**`aro guard` と CI によって機械的に検証される**。
`severity: fail` の違反は PR の required check が落ちるため、merge に至らない。
`severity: warn` の違反は exit 0 で報告のみだが、この改善ループでは中止条件として扱う
（手順 4 参照）。

1. 変更してよいのは `ai.allowed_paths` に一致する path のみ。
2. `ai.forbidden_paths`（および適用 policy の `forbidden_paths`）に一致する path は決して変更しない。
3. 1 回の改善で触れるファイルは `ai.max_changed_files` と適用 policy の `change_limits.max_changed_files`
   の小さい方以下、追加行数は適用 policy の `change_limits.max_added_lines` 以下に収める。
4. 改善ループは `ai.max_loops` 回までで打ち切る。
5. `.ai/managed/**` と `.ai/ai-repo-ops.lock.yaml` は編集しない（aro が管理）。
6. `.github/workflows/**` と `.ai/project.yaml` は編集しない（前者は既定の禁止、
   後者は変更すると guard が `project_config` violation として必ず表面化させる）。
7. 提案ファイルの `status` の変更は、**実装完了に伴う `accepted` → `done` だけ**が許される。
   それ以外の遷移（採否の変更・`superseded` 化・提案の削除）は人間のみが行う
   （guard が `proposal_decision` violation として required check を落とす）。

## 進め方

0. **開始前の安全確認**: `git status --short` を実行し、clean worktree であること（または専用
   branch / worktree で作業していること）を確認する。**既存の未コミット変更がある場合は、
   開発者に確認するまで一切の変更・破棄を行わない。** `git fetch origin <default branch>` を
   実行してから、**最新の default branch を起点に**専用 branch を切る
   （例: `git switch -c chore/ai-improve-<topic> origin/<default branch>`）。
   古い HEAD の上で作業すると、次の手順の stale 判定が upstream の source 変更を見落とす。
1. **改善対象を選ぶ**:
   - まず `.ai/local/proposals/**` を読み、**`status: accepted` の提案から 1 件選ぶ**ことを
     既定とする（採用済み提案は人間が実装を待っているキューである）。
   - 選ぶ前に `aro proposals check --repo .` を実行し、**出力の findings を確認する**。stale
     （`proposed_at_commit` 以降に source が変わっている）は `--strict` なしでは **warn として
     報告され exit 0 のまま**なので、exit code だけで判断せず `source.stale` の findings を読むこと。
   - **stale と報告された accepted は実装対象に選ばない**（もう成立しない診断に基づく実装になる）。
     stale の一覧を開発者に報告する。復帰は人間の仕事である: 開発者が根拠を現在の HEAD で
     再確認し、`proposed_at_commit` を更新する（`status` は変えないため guard は通る）。
   - 実装可能な（stale でない）accepted が**複数ある場合は、一覧を開発者に提示して選択を仰ぐ**
     （提案の順位付け・選抜は AI の仕事ではない）。
   - accepted が**すべて stale の場合は、自選の改善に進まず停止**し、開発者に再確認を求めて
     このループを終了する（stale の滞留を自選で覆い隠さない）。
   - `accepted` が 1 件も無い場合のみ、従来どおり小さく安全な改善を自分で 1 つ選ぶ
     （lint 修正、テスト追加、デッドコード削除、ドキュメント整備など）。
2. 変更を実施する。
3. **自己検証を行う（両方とも通ること）**:
   - `git fetch origin <default branch>` してから
     `aro guard --repo . --base origin/<default branch>` — policies 違反の機械検証
     （fetch 済みの `origin/<default branch>` を使うと、ローカルの default branch が
     古くても CI に近い merge-base で検証できる）。
     **`severity: warn` の違反も中止条件として扱う**（exit 0 でも警告が 1 件でもあれば
     手順 4 に従い、変更を破棄して提案に留める）。warn は人間の PR を通すための緩和であって、
     AI の行動半径を広げるものではない。
   - `quality_gates.required` に対応する `commands.*` のコマンド — すべて緑であること
4. guard 違反・gates 失敗を解消できない、または `max_changed_files` を超える場合は
   変更を破棄する（無理に通そうとしない）。
   **破棄してよいのは、この改善ループで自分が作成・変更したファイルだけ。破棄前に
   対象ファイルの一覧を開発者へ提示して確認を得る。**
   提案を実装していた場合、その提案は **`accepted` のまま据え置き**（`open` へ戻さない。
   破棄されたのは実装の試みであって、人間が下した採用の判断ではない）、提案本文の
   「リスク・見送る理由になりうる点」に破棄の日時・理由・その時点の HEAD SHA を追記する。
   **この破棄の記録は捨てない**: 実装の変更を破棄した後、提案ファイルだけの変更として
   commit し、開発者の確認を得て PR にする（`status` が変わらないため guard の違反にならず、
   通常どおり merge できる。記録が残ることで、同じ提案の再実装が同じ理由で失敗するのを防ぐ）。
5. 自己検証が通ったら、改善内容を開発者に提示する。提案を実装した場合は、**その提案の
   `status` を `accepted` → `done` に変更し、同じ PR に含める**（この遷移だけは guard の
   違反にならない。実装を伴わない `done` 化は人間がレビューで却下する）。
   提案ファイルを変更した場合（`done` 化・破棄記録の追記のどちらでも）は、最終状態に対して
   `aro proposals check --repo . --strict` を再実行して通ることを確認する（CI は提案の変更を
   含む PR を strict で検証するため、ローカルでも同じ条件で確認しておく）。
   **PR の作成は開発者の確認を得てから**行う（タイトル規約: `chore(ai-improve): <改善の要約>`）。
   `require_human_review` が true の間は自動 merge しない（merge は常に人間が判断する）。

## 出力

- 実施した改善の要約（目的 / 変更ファイル / リスク / 実装した提案の id。
  自選の改善で対応する提案が無い場合は id を「なし」と明記する）。
- 自己検証の結果（`aro guard` の判定と、実行した quality gate の結果）。
- 実装中に見つけた**新しい改善候補はここに書き残さない**。propose プロンプト
  （`.ai/managed/prompts/propose.md`）で `.ai/local/proposals/` に提案ファイルとして書き出す
  （出力に書かれただけの候補は消える。提案ファイルは残り、人間の採否と次の実行の入力になる）。

スコープを広げすぎないこと。1 PR = 1 つの明確な改善に保つ。
