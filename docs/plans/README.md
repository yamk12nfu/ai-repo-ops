# Post-MVP 計画書インデックス

MVP（Phase 0〜7: `aro init` / `diff` / `sync` / `doctor`）完了後の実装計画。
各計画書は「**完了すると何ができるようになるか**」を冒頭に明示する。

## 一覧と着手順

| # | 計画 | できるようになること（要約） | 前提 | 着手条件 |
|---|---|---|---|---|
| 01 | [リリース基盤（v1 タグ）](./01-release-v1.md) | `aro init` した repo の workflow が実際に起動する。中央の状態に名前を付けて配布できる | なし | **即時**（現状は配布 workflow が解決不能で破損中） |
| 02 | [AI レビューコメンター](./02-ai-review-commenter.md) | PR を開くと AI レビューコメントが自動で付く。配布物（prompts / policies / project.yaml）の設計を実運用で検証できる | 01 | 01 完了後すぐ。dogfooding とセット |
| 03 | [aro guard + 改善ループ](./03-guard-and-improve-loop.md) | 週次で AI が改善 PR を自動作成する（merge は人間）。policies が機械的に強制される | 01, 02 | 02 の dogfooding で payload の妥当性が確認できたら |
| 04 | [パッケージング](./04-packaging.md) | 中央 repo の外・任意の場所から `aro` を実行できる | 01 | fleet（05）に着手する前まで |
| 05 | [fleet 診断 + rollout](./05-fleet-and-rollout.md) | 全対象 repo の状態を一覧できる。差分のある repo へ一括同期 PR を出せる | 04 | 参加 repo が 3 個を超えたら |

## 着手順の考え方

1. **01 は破損修正**。配布される `ai-review.yml` は `yamk12nfu/ai-repo-ops/...@v1` を参照するが、`v1` タグはリモートに存在しない。`aro init` した repo は PR を開いた時点で workflow 解決エラーになるため、他のすべてに先行する。
2. **02 を前倒しする**（実装計画書 v3 の Post-MVP Phase D の先頭部分に相当）。prompts / policies /
   `project.yaml` スキーマの設計が妥当かは、消費者が動いて初めて検証できる。配布機構（fleet / rollout）を
   先に磨くと、未検証の payload を大量配布する仕組みが先に完成してしまう。ただし最初の一歩は
   **書き込みゼロ（PR コメントのみ）** に限定し、安全に導入する。
3. **03 で自律改善ループを閉じる**。プロンプトで「守れ」と言うだけだった policies に、`aro guard` という
   機械的な消費者を作ってから改善 PR の自動作成を解禁する。実装は **Stage 1（`aro guard`。AI 不要で
   独立にテスト・merge 可能）と Stage 2（改善 PR 作成。`contents: write` の解禁はここのみ）に分割し、
   別 PR で進める**。
4. **04 / 05 は配布規模の拡大**。参加 repo 数が増えてから価値が出るため、02 / 03 の後に置く。

## 計画化を保留しているもの（運用データ待ち）

以下は実装計画書 v3 の Post-MVP Phase A / C / E に相当するが、dogfooding（02）で痛みが実証されるまで計画化しない。

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
