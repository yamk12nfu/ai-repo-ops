# Post-MVP 計画書インデックス

MVP（Phase 0〜7: `aro init` / `diff` / `sync` / `doctor`）完了後の実装計画。
各計画書は「**完了すると何ができるようになるか**」を冒頭に明示する。

## 一覧と着手順

| # | 計画 | できるようになること（要約） | 前提 | 着手条件 |
|---|---|---|---|---|
| 01 | [リリース基盤（v1 タグ）](./01-release-v1.md) | `aro init` した repo の workflow が実際に起動する。中央の状態に名前を付けて配布できる | なし | **完了**（v0.1.0） |
| 02 | [AI レビューコメンター](./02-ai-review-commenter.md) | ~~PR を開くと AI レビューコメントが自動で付く~~ **方向転換**: 実装は v0.1.1 で完了したが dogfooding は中止（CI での API キー AI 実行・secrets 配布・自前レビュー基盤は方針に合わない）。payload 検証は 03 に引き継ぎ | 01 | **打ち切り**（経緯は計画書冒頭の注記参照） |
| 03 | [aro guard + ローカル改善ループ](./03-guard-and-improve-loop.md) | policies が `aro guard` で機械的に強制される（CI は AI なしの決定的検証）。改善ループは開発者が手元の Claude Code で回す（API 課金・secrets 配布なし） | 01 | **次の本命**。Stage 1（guard）から着手 |
| 04 | [パッケージング](./04-packaging.md) | 中央 repo の外・任意の場所から `aro` を実行できる | 01 | fleet（05）に着手する前まで。03 Stage 1 の CI 組み込みを楽にする効果もある |
| 05 | [fleet 診断 + rollout](./05-fleet-and-rollout.md) | 全対象 repo の状態を一覧できる。差分のある repo へ一括同期 PR を出せる | 04 | 参加 repo が 3 個を超えたら |

## 着手順の考え方

1. **01 は破損修正**（完了）。配布される `ai-review.yml` は `yamk12nfu/ai-repo-ops/...@v1` を参照するが、`v1` タグはリモートに存在しなかった。`v0.1.0` リリースで解消済み。
2. **02 は実装後に方向転換**（v0.1.1 で実装・リリース済み、dogfooding は中止）。CI で従量課金 API キーの
   AI を動かす方式・secrets を repo ごとに配る運用・自前レビュー基盤は方針に合わないと確定した。
   PR レビューは既存サービス（CodeRabbit 等）に任せる。「消費者を動かして payload を検証する」という
   目的自体は正しいままなので、03 の guard（機械的な消費者）とローカル改善ループ（AI の消費者）に
   引き継ぐ。実装から得た互換性契約（reusable workflow の inputs / secrets 名の凍結）は 03 の
   エンジン差し替えでそのまま活きる。
3. **03 が本命**。方針は「**AI はローカル、CI は決定的検証**」。プロンプトで「守れ」と言うだけだった
   policies に `aro guard` という機械的な消費者を作り（Stage 1。AI 不要で独立にテスト・merge 可能）、
   CI の reusable workflow のエンジンを guard に差し替える。改善ループは CI の cron ではなく
   開発者が手元の Claude Code（自身のサブスクリプション）で回す（Stage 2）。これにより
   `contents: write` の解禁も secrets の配布も不要になる。
4. **04 / 05 は配布規模の拡大**。参加 repo 数が増えてから価値が出るため、03 の後に置く。
   04 は 03 Stage 1 の「CI で `aro` を動かす」手段を改善する副次効果もある。

## 計画化を保留しているもの（運用データ待ち）

以下は実装計画書 v3 の Post-MVP Phase A / C / E に相当するが、dogfooding（03 Stage 2 のローカル改善ループ）で痛みが実証されるまで計画化しない。

- **conflict UX**（`aro explain-conflict` / `reset-managed` / `prune`）— managed file の直接編集による
  conflict が実際にどの頻度で起きるかを見てから。`git restore` 手順（README 記載）で当面は代替できる。
- **schema migrations**（`aro upgrade`）— 実装は保留するが、方針は
  [`docs/plans/00-schema-evolution.md`](./00-schema-evolution.md) に書いた。
  `schema_version` の意味 / minor compatible と major breaking の扱い /
  `aro doctor` が旧 schema をどう扱うか / `aro upgrade` が必要になる条件 /
  `.ai/project.yaml` の `create_only` 戦略との関係を扱う。実装（`aro upgrade` 本体）は
  同文書に記載の着手条件（実際に major 変更が必要になる・参加 repo 数が増える等）を満たすまで保留する。
  `.ai/project.yaml` は各 repo に散らばるローカル設定であり、後から方針を変えると移行コストが跳ねる。
- **telemetry** — 改善ループ（03）が実際に回り始めてから。`auto_merge` 解禁の判断材料もここで貯める。

## 計画書の書式

各計画書は次の構成をとる。

1. **できるようになること** — Before / After で観測可能な能力を列挙（この文書群の主目的）
2. **現状とギャップ** — repo 内の事実（ファイルパス・実装）に基づく現状
3. **スコープ / 非スコープ**
4. **実装タスク**
5. **受け入れ条件（DoD）** — 「できるようになること」を検証可能な形で言い換えたもの
6. **リスク / 未決事項**
