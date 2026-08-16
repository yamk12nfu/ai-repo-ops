---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: propose-prompt-guard-command-drift
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: 6bd4d2ede327e71f5e7fba1121eb63c17e16e412
sources:
  # 注: 対象そのものは distribution/base/files/.ai/managed/prompts/propose.md（20 行目）だが、
  # source path の組み込み禁止パターン `**/.ai/**` が distribution 配下のコピーにも当たるため
  # source には指定できない。distribution の変更を伴うため manifest を stale 検出の代理にする。
  - path: "packages/aro-cli/src/commands/guard.ts"
  - path: "distribution/base/manifest.yaml"
---

## 課題

配布 prompt `distribution/base/files/.ai/managed/prompts/propose.md` の「入力」節（20 行目）が、
提案の種として「`aro guard --json` の違反（`severity: warn` を含む）」を挙げているが、
このコマンドはそのままでは実行できない。`aro guard` は `--base <ref>` が必須オプションであり
（`packages/aro-cli/src/commands/guard.ts` の `requiredOption("--base <ref>", ...)`）、
`--base` なしで実行すると `error: required option '--base <ref>' not specified` になる
（本提案の作成中に実際に踏んだ）。

同じ propose.md の自己検証手順（79 行目）や improve.md のコマンド例は
`aro guard --repo . --base origin/<default branch>` と正しい形で書かれており、
「入力」節の 1 箇所だけが実行不能な形で残っている。プロンプトに従う AI がここで
エラーに当たり、base の指定を自力で推測する余地（誤った base の選択を含む）が生まれる。

## 提案

配布 propose.md の「入力」節のコマンド例を、実行可能かつ他の箇所と一貫した形

`aro guard --repo . --base origin/<default branch> --json`

に修正する。distribution の変更なので `distribution/base/manifest.yaml` を実装時点の current
version から次の配布 version へ bump し、CHANGELOG への記載を同一 PR で行う。

## 想定する変更範囲

- `distribution/base/files/.ai/managed/prompts/propose.md`（1 行修正）
- `distribution/base/manifest.yaml`（version bump）
- `CHANGELOG.md`
- 3 ファイル程度で `ai.max_changed_files: 10` に収まる。self の `.ai/managed/prompts/propose.md`
  への反映は、既存提案 `self-sync-must-follow-release` が指摘する順序制約により
  同一 PR では行えず、リリース（v1 タグ移動）後の別 PR での self-sync になる。

## リスク・見送る理由になりうる点

- 修正自体は 1 行で、単体では distribution version bump + リリース + 各 repo への sync という
  配布コストに見合わない可能性がある。次に distribution を触るリリースへ相乗りさせる
  （それまで open のまま保持する）判断も十分に合理的。
- 「`--json` の出力を提案の種に使う」という記述自体を、コマンド例なしの散文に変える
  選択肢もある（プロンプトがコマンド例を持つほど、CLI 変更のたびにプロンプトが腐る）。
  その場合は修正ではなく記述方針の変更になり、本提案の範囲を超える。
- 実害の頻度は低い: guard がクリーンな repo では違反一覧は空で、この入力源自体が
  出番のないことが多い（今回の self repo でも違反 0 件だった）。
