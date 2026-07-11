# ローカル改善ループ（AI はローカル、CI は決定的検証）

`ai-repo-ops` に参加している repo の継続的な改善を、**開発者の手元の AI（Claude Code 等、
開発者自身のサブスクリプション）**で回す運用の手順書である（[計画 03](./plans/03-guard-and-improve-loop.md)
Stage 2）。CI の cron で AI を実行する方式は採らない（経緯は
[計画 02 の注記](./plans/02-ai-review-commenter.md)）。従量課金 API キー・repo ごとの secrets 登録・
CI への書き込み権限の追加は一切不要。

```txt
開発者のローカル                              CI（中央が配布した workflow）
┌─────────────────────────────┐   PR    ┌────────────────────────────┐
│ Claude Code + improve.md     │ ──────► │ aro guard（機械検証・強制）  │
│  └ 改善 1 つ実施             │         │ 既存レビューサービス          │
│  └ 自己検証:                 │         │ （CodeRabbit 等）           │
│     aro guard + quality gates│         └────────────────────────────┘
│  └ 開発者が確認して PR 作成   │            merge は常に人間が判断
└─────────────────────────────┘
```

## 前提

- 対象 repo が `aro init` 済みであること（`.ai/project.yaml` / `.ai/managed/**` が存在する）。
- ローカルに AI 実行環境（Claude Code 等）と `gh` CLI があること。
- `aro` CLI が実行できること（MVP では中央 repo 内の `pnpm aro ...` または `pnpm link --global`。
  [README](../README.md) の「使い方」参照）。
- **clean worktree で開始すること**（または専用 branch / worktree で行うこと）。開発者の
  未コミット変更が残った状態で始めると、改善の失敗時に AI がループ由来でない変更まで
  巻き込んで破棄する事故につながる（improve.md はループ由来のファイル以外の破棄を禁じているが、
  運用側でも入口で守る）。

## 手順（1 周分）

1. **起動**: 対象 repo で作業状態を確認し、専用 branch を切ってから Claude Code を起動し、
   配布済みプロンプトを読み込ませる。

   ```bash
   git status --short                        # 空であること（未コミット変更を持ち込まない）
   git switch -c chore/ai-improve-<topic>    # 専用 branch で作業する
   ```

   ```txt
   .ai/managed/prompts/improve.md を読んで、その手順に従って改善を 1 つ実施して
   ```

2. **改善の実施**: AI が `.ai/project.yaml` と適用 policy（`project.risk_level` に対応する
   `.ai/managed/policies/*.yaml`）を読み、小さく安全な改善を 1 つ実施する。

3. **自己検証**: AI（または開発者）がローカルで次の両方を通す。

   ```bash
   git fetch origin <default branch>
   aro guard --repo . --base origin/<default branch>   # 例: --base origin/main（exit 0 であること）
   # + quality_gates.required に対応する commands.*（lint / test 等）
   ```

   fetch 済みの `origin/<default branch>` を使うと、ローカルの default branch が古くても
   CI に近い merge-base で検証できる（[guard.md](./guard.md) の CI での利用と同じ発想）。

   guard 違反・gates 失敗を解消できない場合、その改善は破棄する（improve.md がそう指示している）。

4. **PR 作成**: 開発者が変更内容を確認したうえで PR を作成する（開発者自身の GitHub 権限を使う。
   CI 用の書き込み権限は増えない）。タイトル規約: **`chore(ai-improve): <改善の要約>`**。
   PR 本文には improve.md の出力（改善の目的 / 変更ファイル / 自己検証の結果 / 次の改善候補）を含める。

5. **CI の最終検証**: PR を開くと中央配布の workflow が `aro guard` を再実行する
   （ローカルの自己検証は自己申告にすぎないため、CI 側で必ず再検証する。[guard.md](./guard.md) 参照）。
   あわせて既存のレビューサービス（CodeRabbit 等）と人間がレビューし、**merge は常に人間が判断する**
   （`auto_merge` は封印されている）。

## 安全性の設計

- **権限が増えない**: ループ全体を通して、対象 repo にも中央にも新しい secrets・API キー・
  書き込み権限は追加されない。書き込みは開発者自身の権限による PR のみ。
- **guard の二段構え**: ローカル（自己検証。手戻りを早く検出）と CI（強制。自己申告に依存しない）。
  検証ルールは merge-base 側から読まれるため、PR 内で設定を緩めても迂回できない。
- **人間の関与が前提**: 起動・PR 作成・merge のすべてに開発者の判断が挟まる。CI cron のような
  無人実行はしない（改善の質が低い場合に無意味な PR が量産されるリスクも、人間が起動する分だけ低い）。

## Repo Knowledge Loop との関係

この文書の `improve.md` ループは、source codeや設定の改善を1件実施するためのもの。repo固有の索引・
要約だけを更新する場合は、別の `.ai/managed/prompts/knowledge-refresh.md` を使う。

```txt
.ai/managed/prompts/knowledge-refresh.md を読み、Repo Knowledge を1単位だけ更新して
```

knowledge更新は `.ai/local/knowledge/**` だけを編集し、`aro knowledge check --strict` で根拠と鮮度を
検証する。source codeを変更する改善と同じPRへ混ぜず、source変更を先にcommitした後、そのHEADを根拠に
小さなknowledge更新を作る。形式・導入手順・安全境界は
[`repo-knowledge-loop.md`](./repo-knowledge-loop.md) を参照。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| ローカルの `aro guard` が exit 1 | 違反一覧を確認。改善対象を `allowed_paths` 内に収め直すか、その改善を破棄する |
| ローカルは通ったが CI の guard が fail | base branch が進んで merge-base が変わった可能性。branch を rebase して再実行 |
| `aro guard` が exit 3（`PROJECT_CONFIG_NOT_FOUND`） | base に `.ai/project.yaml` が無い（導入 PR 直後等）。導入 PR の merge 後から guard 対象になる |
| quality gates のコマンドが空で検証にならない | `.ai/project.yaml` の `commands.*` を repo に合わせて設定する（`aro doctor` が WARN で検出する） |

## dogfooding で記録すること（Stage 2-3）

- improve.md の指示の精度（意図しない改善・スコープ超過が起きないか）
- guard の誤検知 / 見逃し（`allowed_paths` の glob が実運用に合っているか）
- 1 周にかかる手間（自己検証の待ち時間、PR 規約の運用しやすさ）
- 気づきは [計画 03](./plans/03-guard-and-improve-loop.md) Stage 2-3 の判断材料として記録する
