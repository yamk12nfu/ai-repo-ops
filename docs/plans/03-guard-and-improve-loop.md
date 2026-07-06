# 計画 03: `aro guard` + ローカル改善ループ — AI はローカル、CI は決定的検証

優先度: 高 / 前提: 計画 01（計画 02 は実装のみ。dogfooding は本計画に引き継ぎ） / 規模: 大
（**Stage 1 / Stage 2 に分割し、別 PR で実装する**）

- **Stage 1: `aro guard` + CI への組み込み** — AI 不要。fixture repo に diff を作ればテストが完結する
  独立実装。CI 側の消費者（reusable workflow）もここで guard ベースに置き換える
- **Stage 2: ローカル改善ループ** — 開発者が手元の Claude Code（サブスクリプション）で
  `improve.md` / policies を消費して改善を回す。**CI 内で AI は実行しない**

> **方針（2026-07-05 改訂）**: 従量課金 API キーで CI 上の AI を動かす方式・secrets を対象 repo ごとに
> 配る運用・自前 AI レビュー基盤は採らない（経緯は [計画 02 の方向転換注記](./02-ai-review-commenter.md)
> を参照）。PR レビューは既存サービス（CodeRabbit 等）に任せ、本計画は次の分担に立つ。
>
> - **CI（中央が配布する workflow）**: AI なしの決定的検証だけを行う（`aro guard` / quality gates / doctor）
> - **AI の実行**: 開発者のローカル環境（Claude Code 等、開発者自身のサブスクリプション）で行う
> - **中央（ai-repo-ops）**: プロンプト・ポリシーの配布と、それを機械的に強制するガードレールの提供に徹する

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| policies の強制 | `allowed_paths` / `max_changed_files` 等はプロンプトで AI に「お願い」するだけ | **`aro guard` が diff を機械検証する**。モデルの従順さに依存しない |
| PR 時の CI | `ai-review.reusable.yml` は AI レビュー（API キー未登録なら skip = 実質何もしない） | PR を開くと **`aro guard` が policies 違反を検出して fail / コメントする**。API キー・secrets 不要で全対象 repo が即恩恵を受ける |
| 改善ループ | `ai-improve.reusable.yml` は stub。回す手段がない | **開発者が手元の Claude Code で改善ループを回せる**（配布済み `improve.md` + `project.yaml` + policies を消費 → ローカルで guard + gates を自己検証 → 開発者の権限で PR）。API 課金・secrets 配布なし |
| 配布物の検証 | prompts / policies に消費者がいない | guard（機械）と ローカル改善ループ（AI）の両方が policies を消費し、payload 設計が実運用で検証される |

## 現状とギャップ

- `aro guard` は存在しない。制約の実体は**プロンプト内の文章だけ**。diff を検証するコードがない。
- 検証に必要な部品は core に揃っている: `core/paths.ts`（glob マッチ・path 安全性）、
  `core/lockfile.ts` / `core/checksum.ts`（managed file の不可侵検証）。
- `ai-review.reusable.yml`（v0.1.1）は claude-code-action ベースの AI レビューだが、API キー未登録なら
  skip するだけで、対象 repo に価値を提供していない。互換性契約（`workflow_call` の inputs:
  `config_path` / `lock_path`、secrets: `anthropic_api_key`）は凍結済みで、**エンジンは中央の内部実装
  として自由に差し替えられる**（このための契約設計だった）。
- `ai-improve.reusable.yml` は echo のみの stub。配布側 `ai-improve.yml` は `workflow_dispatch` + cron。
- `improve.md` プロンプトはループ 1 周分の手順（小さい改善を 1 つ → gates 実行 → 緑なら PR、
  ダメなら中止して提案のみ）と `ai.max_loops` での打ち切りまで規定済み。ローカル実行でもそのまま使える。
- `risk_level` → policy の対応規則は計画 02 実装で確定済み（`low`→`low-risk.yaml` /
  `medium`→`default.yaml` / `high`→`security.yaml`。`ai-review.reusable.yml` に実装がある）。
  guard はこの規則を TypeScript 側（`core/`）に正式実装する。

## スコープ

- `aro guard` サブコマンドの実装（Stage 1）
- `ai-review.reusable.yml` のエンジンを AI レビューから `aro guard` に差し替え（Stage 1）
- ローカル改善ループの運用手順・ドキュメント整備と dogfooding（Stage 2）
- `ai-improve` 系配布物（cron での AI 実行を前提にした workflow）の扱いの決定（Stage 2）

## 非スコープ

- **CI 内での AI 実行**（AI レビュー・AI 改善 PR の自動作成。方針転換により恒久的に非スコープ）
- **`contents: write` の解禁**（CI 内で AI が push しないため不要になった。セキュリティ上も改善）
- **secrets の配布**（`anthropic_api_key` の受け取り口は互換性契約として残すが、使わない）
- `auto_merge` の解禁（ローカルループでも `require_human_review: true` を維持）
- 改善結果の蓄積・レポート（telemetry。運用データ待ち）
- Issue 起点の修正（`issue-fix.md` の消費は改善ループ安定後）

## 実装タスク

### Stage 1-1: `aro guard`（policies の機械的 enforcement）

```bash
aro guard --repo <path> --base <ref>   # <ref>..HEAD の diff を検証。CI では base branch を渡す
```

検証項目（`project.yaml` の `ai.*` と適用 policy から読む）:

- 変更された全 path が `allowed_paths` のいずれかに一致する
- `forbidden_paths` に一致する path の変更がない（policies 側の `forbidden_paths` もマージして評価）
- 変更ファイル数が `max_changed_files` 以下、追加行数が policy の `max_added_lines` 以下
- `.ai/managed/**` と `.ai/ai-repo-ops.lock.yaml` に変更がない（lock との checksum 照合を再利用）
- `.github/workflows/**` に変更がない（既定の forbidden。workflow の自己書き換えを禁止）

設計方針:

- **読み取り専用**（diff を読むだけ。doctor と同じ思想）
- 終了コード: `0`=違反なし / `1`=違反あり / `3`=unexpected error（doctor の設計に揃える）
- `--json` で違反一覧を機械可読出力（CI の step summary やローカルループから使えるように）
- 判定ロジックは新設の `core/guard.ts` に置き、CLI から分離（doctor / diff と同じ構造）
- `risk_level` → policy の選択ロジックも `core/` に実装し、workflow 内の shell 実装を将来こちらへ寄せる

### Stage 1-2: `ai-review.reusable.yml` のエンジンを guard に差し替える

互換性契約（inputs / secrets の名前）は維持したまま、job の中身を差し替える。
**対象 repo は何も変更しなくてよい**（`@v1` 参照のまま、次の `v1` 移動で自動的に切り替わる）。

1. checkout（base との diff が取れる深さ）+ 中央 ai-repo-ops の checkout（`aro` を build して使う。
   計画 04 のパッケージングが済めば installation に置き換え）
2. `aro guard --repo . --base <PR base>` を実行
3. 違反があれば job を fail させ、違反一覧を step summary（および可能なら PR コメント）に出力
4. `secrets.anthropic_api_key` は受け取り口だけ残し（契約凍結のため）、使わない。
   AI レビュー実装（claude-code-action 統合）は削除する
5. permissions から `id-token: write` を外せるか確認（guard に OIDC は不要。
   ただし配布側 `ai-review.yml` は `create_only` で既存 repo に残るため、
   reusable 側が要求しなければ caller 側に余分な permission があっても害はない）

> 註: guard は「PR を block する」検証なので、AI レビュー（non-blocking）と違い required check に
> してよい。ただし導入初期は警告のみ（fail させない）モードで様子を見る選択肢も残す。
> 名称（`ai-review.yml` のまま guard を動かすか、将来 `guard.yml` に改名するか）は
> `aro doctor` の WORKFLOW_SPECS・manifest の seed 定義とセットで実装時に決める
> （改名は `create_only` の制約で既存 repo に自動反映されない点に注意）。

### Stage 2-1: ローカル改善ループの運用設計

CI の cron で AI を実行する代わりに、開発者が手元で回す:

1. 開発者が対象 repo で Claude Code（等）を起動し、`.ai/managed/prompts/improve.md` を読み込ませる
   （`improve.md` はローカル実行を前提にした文言へ改訂する: 「`gh pr create` する」等の手順は
   開発者の権限・環境で行う前提に書き換え）
2. AI が `project.yaml` + 適用 policy を読み、小さな改善を 1 つ実施
3. **ローカルで自己検証**: `aro guard --repo . --base <default branch>` + `quality_gates.required` の
   コマンドを実行。違反・失敗なら改善を破棄（または人間に相談）
4. 開発者が内容を確認して PR を作成（開発者自身の GitHub 権限。CI 用の書き込み権限は一切増えない）
5. CI 側では Stage 1-2 の guard workflow + 既存レビューサービス（CodeRabbit 等）が最終検証

成果物:

- `improve.md` のローカル実行向け改訂（distribution 更新 → sync で配布）
- 運用手順のドキュメント（`docs/local-improve-loop.md` 等。起動方法・自己検証・PR 規約
  `chore(ai-improve): <要約>` を記載）
- 必要なら `aro` 側の補助（例: `aro guard --json` の出力をループが読みやすい形にする）。
  専用サブコマンド（`aro improve`）の新設は、手動運用で痛みが実証されるまで見送る

### Stage 2-2: `ai-improve` 系配布物の整理

> **実施済み（2026-07-07）**: 配布側 `ai-improve.yml`（cron + `contents: write`）を**配布物から除去**した
> （manifest から seed エントリを削除・配布ファイルを削除・manifest version bump）。
> `ai-improve.reusable.yml` は、除去前に seed された既存 repo の `@v1` 参照を壊さないための
> **no-op stub**（`contents: read` のみ）としてのみ残す。`aro doctor` は ai-improve を必須 workflow
> から外し、残置を検出したら手動削除を案内する WARN（`workflow.ai-improve.legacy`）に変更した。
> dogfooding を待たずに除去した理由: CI 内 AI 実行は本計画で恒久的に非スコープと確定しており、
> seed 済み repo がほぼ存在しない今が既存 repo への影響が最小のタイミングであるため。

CI 内 AI 実行がなくなったため、cron 前提の `ai-improve` 系 workflow は役割を失う:

- `ai-improve.reusable.yml`（stub）と配布側 `ai-improve.yml`（cron + dispatch）を**配布物から除く**か、
  無害な stub のまま残すかを決める（`create_only` のため、除いても既存 repo からは消えない。
  `aro doctor` の WORKFLOW_SPECS・manifest との整合もセットで変更する）
- 判断基準: ローカル改善ループの dogfooding で「CI 側に改善系の workflow が必要になる場面」が
  観測されるかどうか。観測されなければ次の distribution 更新で除く

### Stage 2-3: dogfooding（計画 02 から引き継ぎ）

- 実 repo 1〜2 個で: `aro init`（または sync）→ ローカル改善ループを数回実施 → guard / gates /
  prompts の使い勝手を記録
- distribution を 1 回以上更新して `aro diff` → `aro sync` を通す（配布 → 消費 → 改善 → 再配布の
  ループを 1 周させる）
- 気づき（プロンプトの精度・guard の誤検知/見逃し・doctor の WARN の妥当性・conflict の発生頻度）を
  記録し、保留中の計画（conflict UX 等）の要否判断材料にする

## 受け入れ条件（DoD）

### Stage 1（ここまでで独立して merge 可能）

- [ ] 違反を含む diff（forbidden path 変更・`max_changed_files` 超過・managed file 編集）で
      `aro guard` が exit 1 と違反一覧を返す（ユニットテストで担保。AI は一切関与しない）
- [ ] 違反のない diff で exit 0、`--json` が機械可読の結果を返す
- [ ] PR を開くと guard が CI で実行され、違反が step summary に出る（API キー・secrets 不要）
- [ ] 対象 repo 側の変更なしで（`v1` 移動のみで）guard ベースの CI に切り替わる

### Stage 2（ローカル改善ループ）

- [ ] 手元の Claude Code から `improve.md` を使った改善が 1 周回り、guard + gates の自己検証を経て
      **人間レビュー済みの PR が最低 1 件 merge される**
- [ ] ループ全体を通して、対象 repo にも中央にも新しい secrets・API キー・書き込み権限が増えていない
- [ ] `auto_merge` がコード上どこからも呼ばれていない（封印の確認）
- [ ] dogfooding の気づきが記録され、`improve.md` / policies の改訂に反映されて sync で配布される

## リスク / 未決事項

- **guard の誤検知**: glob マッチの解釈（`allowed_paths` に無い新規ディレクトリの扱い等）が厳しすぎると
  通常の開発を阻害する。導入初期は fail させず警告のみのモードを検討（Stage 1-2 の註参照）。
- **ローカルループの再現性**: CI と違い実行環境が開発者ごとに異なる。guard / gates を「ローカルで通った」
  ことは自己申告にせず、CI 側の guard で必ず再検証する（Stage 1-2 が先行する理由）。
- **改善の質が低い場合**: ローカル実行なので人間が起動・確認する分、CI cron よりも無意味な PR は
  出にくい。まず dogfooding で `improve.md` の「小さく安全な改善」の定義を調整する。
- guard の diff 取得方法（`git diff --numstat` か libgit か）は実装時に決定。まずは git CLI で十分。
- CI で `aro` を動かす方法（中央 repo checkout + build）は暫定。計画 04（パッケージング）が済んだら
  差し替える。
