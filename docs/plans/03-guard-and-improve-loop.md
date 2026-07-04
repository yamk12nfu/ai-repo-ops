# 計画 03: `aro guard` + 改善ループ — 半自律の AI 改善 PR

優先度: 高 / 前提: 計画 01, 02 / 規模: 大（**Stage 1 / Stage 2 に分割し、別 PR で実装する**）

- **Stage 1: `aro guard`** — AI 不要。fixture repo に diff を作ればテストが完結する独立実装
- **Stage 2: 改善ループ** — Stage 1 が安定してから。`contents: write` の解禁はこの段階のみ

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| 改善ループ | `ai-improve.reusable.yml` は stub。cron（毎週月曜 18:00 UTC）は発火するが echo のみ | **週次で AI が小さな改善を実行し、quality gates が緑なら PR が自動で立つ**。merge は人間が判断する（半自律ループ） |
| policies の強制 | `allowed_paths` / `max_changed_files` 等はプロンプトで AI に「お願い」するだけ | **`aro guard` が AI の生成した diff を機械検証する**。モデルの従順さに依存しない |
| ガードレールの検証 | 配布している policies に消費者がいない | policies（`change_limits` / `forbidden_paths` / `block_on`）が CI 上で実際に効く |

## 現状とギャップ

- `.github/workflows/ai-improve.reusable.yml` は echo + config 存在確認のみ。
  `contents: write` / `pull-requests: write` の権限枠は用意済み。
- 配布側 `ai-improve.yml` は `workflow_dispatch` + `schedule`（cron）で発火する設計が完成している。
- `improve.md` プロンプトはループ 1 周分の手順（小さい改善を 1 つ → gates 実行 → 緑なら PR、
  ダメなら中止して提案のみ）と `ai.max_loops` での打ち切りまで規定済み。
- しかし制約の実体は**プロンプト内の文章だけ**。diff を検証するコードは存在しない。
- 検証に必要な部品は core に揃っている: `core/paths.ts`（glob マッチ・path 安全性）、
  `core/lockfile.ts` / `core/checksum.ts`（managed file の不可侵検証）。

## スコープ

- `aro guard` サブコマンドの実装
- `ai-improve.reusable.yml` の実装（AI 実行 → guard → gates → PR 作成）
- 配布側 workflow への secrets 追記と distribution 更新

## 非スコープ

- `auto_merge` の解禁（telemetry で成功率の実績が貯まるまで封印。`require_human_review: true` を維持）
- 改善結果の蓄積・レポート（telemetry。Post-MVP Phase E）
- Issue 起点の修正（`issue-fix.md` は配布済みだが、消費は改善ループ安定後）

## 実装タスク

### Stage 1: `aro guard`（policies の機械的 enforcement）

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
- `--json` で違反一覧を機械可読出力（rollout や telemetry から使えるように）
- 判定ロジックは新設の `core/guard.ts` に置き、CLI から分離（doctor / diff と同じ構造）

### Stage 2-1: `ai-improve.reusable.yml` の実装

ステップ構成（**guard と gates は AI 実行の外側**で走らせる。AI に自己申告させない）:

1. checkout → 作業ブランチ作成（例: `ai-improve/<run-id>`）
2. AI 実行: `improve.md` + `project.yaml` + policies を入力に改善を 1 つ実施させる
3. `aro guard --repo . --base <default branch>` — **非 0 なら即 abort**（PR を作らない。
   step summary に違反内容を出力し、`block_on: forbidden_path_modified` 等の発動として記録）
4. `quality_gates.required` のコマンド（`commands.lint` / `commands.test` 等）を実行 — 失敗なら abort
5. `gh pr create`。タイトル規約: `chore(ai-improve): <改善の要約>`（実装計画書 v3 の rollout 規約に準拠した形式）
6. PR 本文に: 改善の目的 / 変更ファイル / guard・gates の結果 / AI が挙げた「次の改善候補」

### Stage 2-2: 配布・設定

- 配布側 `ai-improve.yml` に secrets 受け渡しを追記（計画 02 と同じ方式、`secrets: inherit` 不使用）
- distribution 更新 → manifest version bump → リリース（計画 01 手順）→ dogfooding repo で sync
- `ai.max_loops` の解釈を docs に明記: MVP では「1 実行 = 1 改善」とし、
  ループ回数制御は harness 内リトライの上限として扱う

## 受け入れ条件（DoD）

### Stage 1（`aro guard`。ここまでで独立して merge 可能）

- [ ] 違反を含む diff（forbidden path 変更・`max_changed_files` 超過・managed file 編集）で
      `aro guard` が exit 1 と違反一覧を返す（ユニットテストで担保。AI は一切関与しない）
- [ ] 違反のない diff で exit 0、`--json` が機械可読の結果を返す

### Stage 2（改善ループ）

- [ ] guard 違反時、PR は作成されず step summary に理由が出る
- [ ] dogfooding repo で cron または手動起動から**AI 改善 PR が最低 1 件作られ、人間レビューを経て merge される**
- [ ] gates（lint / test）失敗時に PR が作られない
- [ ] `auto_merge` がコード上どこからも呼ばれていない（封印の確認）

## リスク / 未決事項

- **`contents: write` の解禁**が本計画の本質的なリスク。緩和策: guard を AI 実行の外側に置く・
  ブランチは `ai-improve/*` に限定・default branch への直 push を branch protection で禁止（対象 repo 側の
  設定手順として docs に記載）。
- **改善の質が低い場合**（無意味な PR の量産）: 週次 cron なので量は限定的。まず dogfooding repo で
  数週間観察し、`improve.md` の「小さく安全な改善」の定義を調整する。
- guard の diff 取得方法（`git diff --numstat` か libgit か）は実装時に決定。まずは git CLI で十分。
- policy の選択ロジック（`risk_level` → `default` / `low-risk` / `security` のどれを適用するか）が
  現状 schema 上で未接続。guard 実装時に `project.yaml` との対応規則を確定させる。
