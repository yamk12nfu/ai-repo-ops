# Dogfooding: scentier-creative-accelerator run 01

実施日: 2026-07-13
状態: 初期導入のdraft PRを作成済み（merge は未実施）

## 対象

- repository: `scentier-jp/scentier-creative-accelerator`
- base branch: `develop`
- stack: Next.js + Convex + Clerk
- ai-repo-ops release: `v0.3.0` / `v1`
- distribution: `base` `0.1.4`
- adoption PR: [scentier-jp/scentier-creative-accelerator#224](https://github.com/scentier-jp/scentier-creative-accelerator/pull/224)
- commit: `ce9c76f`

## 今回のスコープ

初期導入だけを行った。Repo Knowledge の初期化と `improve.md` による改善ループは、導入 PR の merge 後に別 PR で実施する。

## 設定判断

- `risk_level: high`
- `ai.max_loops: 1`
- 1改善あたり最大5ファイル
- source、Convex、test、spec、knowledgeだけを許可
- infrastructure、workflow、environment、generated Convex、Dockerfile、Terraformを禁止
- 人間レビュー必須、auto merge無効
- quality gatesは既存CIに合わせてlint、typecheck、format、unit/integration/component testsを必須化
- 環境変数を必要とするbuildと外部API依存のcontract testsは初期必須ゲートから除外

## 結果

### ai-repo-ops

- `aro init --dry-run`: conflict 0 / warning 0
- `aro init`: 成功
- `aro doctor`: PASS 12 / WARN 0 / FAIL 0
- `aro diff --detailed-exitcode`: drift 0 / conflict 0 / warning 0
- GitHub `ai_review / guard`: PASS

### 対象repoのquality gates

- typecheck: PASS
- lint: PASS（既存warning 1件）
- format check: PASS
- unit tests: 76 files / 718 tests PASS
- integration tests: 1 file / 1 test PASS、5 files / 13 tests SKIP
- colocated component tests: 40 files / 280 tests PASS
- 全体baseline: 118 files / 1002 tests PASS、17 files / 48 tests SKIP

## 観測した摩擦・改善候補

1. package/tagは `0.3.0` だが、ビルド済み `aro --version` は `0.2.0` を表示する。導入は継続可能だが、CLI version表示の修正候補。
2. 対象repoには既存の未コミット変更があった。`aro init` の変更pathは分離できたが、導入PRでは選択的にstageする必要がある。
3. `quality_gates.required` はローカル改善ループ用で、生成されるAI Review workflowは対象repo固有のlint/testを実行しない。既存CIを維持する必要がある。
4. 初回導入PRではbase側に `.ai/project.yaml` がないためguardはskipされる。初回設定をmerge前に完成させる必要がある。

## 中央repoへの反映

CodeRabbitレビューで、中央distributionとguardに追加の不整合が見つかった。対象repoのmanaged fileは
直接編集せず、中央の正本で次を修正した。

- guardの変更ファイル数上限をproject/policyの小さい方へ統一（`8bf8905`）
- improve / issue-fix / knowledge-refresh / review promptをguard境界へ整合（`8769ff8`）
- caller workflowの未使用secret転送を削除し、PR単位concurrencyを追加（`7a30721`）
- distribution `base` を`0.1.5`へ更新

## 次の確認

1. 中央修正をレビュー・mergeし、対象repoへ`aro sync`でmanaged bundleを反映する。
2. high-risk trust policyとして対象repoのcaller workflowを中央のレビュー済み完全SHAへ固定する。
3. PR #224のレビュー指摘とCIを再確認して導入PRをmergeする。
4. 導入PR merge後、`origin/develop` を基準にRepo Knowledgeを別PRで初期化する。
5. Knowledge PR merge後、改善ループを1件実行してStage 2のDoDを検証する。
