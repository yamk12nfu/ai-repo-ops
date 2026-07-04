# 計画 02: AI レビューコメンター — 書き込みゼロの最小 harness + dogfooding

優先度: 高 / 前提: 計画 01 / 規模: 中

> **⚠️ 方向転換（2026-07-05）: 実装は v0.1.1 で完了したが、dogfooding は中止する。**
>
> 実装（`ai-review.reusable.yml` の claude-code-action 統合・secrets 経路・`docs/ai-review.md`）は
> v0.1.1 としてリリース済み。しかしオーナーの方針として以下が確定したため、本計画の残タスク
> （dogfooding・フィードバックループ）は実施しない。
>
> - **従量課金 API キーで CI 上の AI を動かす方式を採らない**（PR ごとの課金が発生する構造にしない）
> - **secrets（`ANTHROPIC_API_KEY`）を対象 repo ごとに配って管理する運用をしない**
> - **自前の AI レビュー基盤を持たない**。PR レビューは既存サービス（CodeRabbit 等）に任せる
> - フォーカスは「自律改善ループ」「リポジトリの質を上げる」方向（[計画 03 改訂版](./03-guard-and-improve-loop.md)）
>
> 実装済みの AI レビューは「API キー未登録なら明示 skip + workflow 成功」の設計のため、
> **キーを登録しない限り何も起きず課金もゼロ**であり、配布済み repo に害はない。配布物からの
> AI 呼び出しの撤去（`ai-review.yml` の guard ベース workflow への置き換え）は計画 03 改訂版の
> スコープで扱う。
>
> 本計画の本来の目的だった「配布物（prompts / policies / `project.yaml`）の設計を実運用で検証する」は、
> ローカル改善ループ（計画 03 改訂版 Stage 2）の dogfooding に引き継ぐ。
> 実装から得られた再利用可能な資産: reusable workflow の互換性契約の設計（inputs / secrets 名の凍結）、
> `risk_level` → policy のマッピング規則、fork PR / secrets 未設定時の skip パターン、
> `create_only` seed file の更新が sync で届かないという運用知見。

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| PR 時の挙動 | `ai-review.reusable.yml` は config path を echo するだけの stub | 参加 repo で PR を開くと、**AI レビューコメントが自動で付く** |
| 配布物の価値 | prompts / policies を配っても消費者がいない（「配布パイプラインだけが完成」した状態） | `.ai/managed/prompts/review.md` と `.ai/project.yaml` が実際に消費され、**payload 設計の妥当性を実運用で検証できる** |
| 運用実績 | 対象 repo での実運用ゼロ | 実 repo 1〜2 個で dogfooding が回り、distribution 更新 → `aro sync` のサイクルを最低 1 周した実績がある |
| リスク | — | AI の書き込みは **PR コメントのみ**。repo の内容には一切触れない |

## 現状とギャップ

- `.github/workflows/ai-review.reusable.yml` は checkout → echo → `test -f config` のみ。
- 配布側の入口（`distribution/base/files/.github/workflows/ai-review.yml`）は
  `pull_request` で発火し、`config_path` / `lock_path` を渡す設計が既に完成している。
- `review.md` プロンプト・policies（`default` / `low-risk` / `security`）・`project.yaml` の
  `ai.allowed_paths` / `forbidden_paths` 等の設定は配布済みだが、読む者がいない。
- 実装計画書 v3 §「secrets」: MVP では secret を扱わない。reusable workflow へ渡す場合は
  明示的な `workflow_call.secrets` のみ許可し、`secrets: inherit` は避ける方針が既にある。

## スコープ

- `ai-review.reusable.yml` の実装（read-only レビュー → PR コメント）
- 配布側 `ai-review.yml` への secrets 受け渡し追記と distribution 更新（sync で行き渡らせる）
- 実 repo 1〜2 個での dogfooding 開始と、その結果による `review.md` / `project.yaml.hbs` の改善

## 非スコープ

- 改善 PR の自動作成・repo 内容への書き込み（→ 計画 03)
- policies の機械的 enforcement（`aro guard`。→ 計画 03。本計画ではプロンプトに含めて AI に渡すのみ）
- レビュー結果の蓄積（telemetry。運用データ待ち）

## 実装タスク（記録。タスク 1〜4 は v0.1.1 で完了、タスク 5〜6 は方向転換により実施しない）

1. **エンジンを選定する**。推奨: `anthropics/claude-code-action`（GitHub Action として保守されており、
   PR コメント投稿まで面倒を見る）。代替: `claude` CLI を直接実行して `gh pr comment` で投稿。
   - **エンジン選択は中央 repo の内部実装である**。対象 repo が参照するのは reusable workflow（`@v1`）
     だけなので、エンジンの差し替えは中央側の変更のみで完結し、配布物の更新・対象 repo の sync は不要。
   - 凍結すべき互換性契約は **`workflow_call` の inputs / secrets の名前**（ここを変えると全対象 repo の
     sync が必要になる）。この境界を reusable workflow 冒頭のコメントに明記する。
     adapter 層のような追加の抽象化は作らない。
2. **`ai-review.reusable.yml` を実装する**:
   - checkout（`fetch-depth` は base との diff が取れる深さ）
   - `.ai/project.yaml` と `.ai/managed/prompts/review.md` を読み、PR diff とともにエンジンへ渡す
   - `risk_level` / `allowed_paths` / `forbidden_paths` / policies をプロンプト文脈に含める
     （「forbidden path への変更を見つけたら指摘する」等、レビュー観点として消費させる）
   - 結果を PR コメント + step summary に出力
   - permissions は現行のまま（`contents: read` / `pull-requests: write` / `issues: write`）。
     **`contents: write` は与えない。**
3. **secrets 経路を通す**:
   - reusable 側: `workflow_call.secrets.anthropic_api_key`（required）
   - 配布側 `ai-review.yml`: `secrets.anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` を追記
   - `secrets: inherit` は使わない（既定方針どおり）
   - distribution 更新に伴い `manifest.yaml` の version bump + リリース（計画 01 の手順で `v0.1.x`）
4. **失敗時の扱いを決める**: AI レビューの失敗（API エラー・レート制限）で PR を block しない。
   required check にはせず、失敗は step summary に残すのみとする。
5. ~~**dogfooding を開始する**~~（**実施しない**。冒頭の方向転換注記を参照）:
   - 自分の実 repo 1〜2 個に `aro init` → 生成物を commit → PR を開いてコメントが付くことを確認
   - `ANTHROPIC_API_KEY` を対象 repo の secrets に登録（この手順を README または docs に記載）
   - 数週間運用し、distribution を 1 回以上更新して `aro diff` → `aro sync` を通す
   - 気づき（プロンプトの精度・doctor の WARN の妥当性・conflict の発生頻度）を記録する
6. ~~**フィードバックを反映する**~~（**実施しない**。payload 検証は計画 03 のローカル改善ループへ）: `review.md` / `project.yaml.hbs` の初期値を運用結果で調整し、
   sync で行き渡ることを確認する（＝配布 → 消費 → 改善 → 再配布のループを 1 周させる）。

## 受け入れ条件（DoD）（記録。方向転換により以後更新しない。実装で担保済みの項目のみ ✔ 相当）

- [ ] 実 repo の PR に AI レビューコメントが自動で付く
- [ ] コメント内容に `project.yaml` の設定（例: forbidden path への変更検知）が反映されている
- [ ] workflow の書き込み権限が `pull-requests` / `issues` に限定されている（`contents: write` なし）
- [ ] AI レビュー失敗時も PR の merge が block されない
- [ ] fork からの PR では AI レビューが**明示的に skip** され、workflow 自体は成功する
      （skip 理由が step summary に出る）
- [ ] distribution 更新 → 対象 repo で `aro sync` → 新しい workflow / prompt が反映される、が 1 周している
- [ ] dogfooding の気づきが記録され、保留中の計画（conflict UX 等）の要否判断材料になっている

## リスク / 未決事項

- **API コスト**: PR ごとに LLM を呼ぶ。dogfooding 規模では問題にならないが、
  参加 repo を広げる前に概算しておく（`synchronize` での再実行を絞る等の調整余地あり）。
- **プロンプトインジェクション**: PR diff は第三者入力になりうる。read-only 設計
  （書き込みは PR コメントのみ・secrets は API key のみ）がこのリスクの主な緩和策であり、
  **この設計を崩す変更（書き込み権限の追加）は計画 03 の guard 実装とセットでのみ行う**。
- fork からの PR では secrets が渡らない（GitHub の仕様）。dogfooding は自分の repo のみなので
  MVP では「fork PR では明示的に skip」で良い（DoD 参照）。
- **`pull_request_target` は使わない**。secrets を持ったまま fork のコードを扱える trigger であり、
  典型的な事故源。fork PR への対応が本当に必要になった時点で、checkout 対象と権限を
  別途セキュリティレビューした上で判断する（それまでは `pull_request` のまま自 repo の PR のみ対応）。
