---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: proposal-filename-convention-unenforced
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: fd23c4fa25ba814e9117990701afc57901359140
sources:
  # 注: 規約の正本は distribution/base/files/.ai/managed/prompts/propose.md（37 行目）だが、
  # source path の組み込み禁止パターン `**/.ai/**` が distribution 配下のコピーにも当たるため
  # source には指定できない。同じ規約を記述する docs/proposal-loop.md で代替する。
  - path: "docs/proposal-loop.md"
  - path: "packages/aro-cli/src/core/proposals-check.ts"
---

## 課題

propose.md（37 行目）は提案ファイル名を `.ai/local/proposals/YYYY-MM-<slug>.md` と規定するが、
`aro proposals check` はファイル名を一切検証しない
（`packages/aro-cli/src/core/proposals-check.ts` に filename 判定は存在しない）。

その結果、規定は最初の 2 件から既に守られていない: merge 済みの既存提案
`self-sync-must-follow-release.md` / `workflow-seed-create-only-manual-followup.md` は
日付 prefix を持たないまま全チェックを PASS している（propose.md 以外の経路 —
knowledge 収穫スキル — で書かれたため）。ドキュメント上の規約と実データが乖離しており、
規約の目的（提案の時系列把握・open 滞留の棚卸しのしやすさ。計画 06 は open の滞留を
最大のリスクと明記している）が最初から機能していない。

## 提案

`aro proposals check` に「ファイル名が `YYYY-MM-<slug>.md` 形式に従っているか」の判定を
**情報提供レベルの warn として**追加する（`--strict` でも fail に昇格させない。
stale と違って提案の内容の信頼性には関わらないため、CI を落とす理由にはしない）。
既存 2 ファイルの rename は本提案の範囲に含めない（提案ファイルの削除を伴う rename は
guard の `proposal_decision` fail を踏むため、やるなら人間の判断で別途行う）。

## 想定する変更範囲

- `packages/aro-cli/src/core/proposals-check.ts`（filename 判定の追加）
- `packages/aro-cli/src/commands/proposals-check-format.ts`（表示）
- `packages/aro-cli/src/core/__tests__/proposals-check.test.ts` /
  `packages/aro-cli/src/commands/__tests__/proposals-check.test.ts`（テスト）
- `CHANGELOG.md`
- 5 ファイル程度で `ai.max_changed_files: 10` に収まる。

## リスク・見送る理由になりうる点

- 逆方向の解決（規約の側を「推奨」に緩めて propose.md の記述を直す）の方が軽い。
  日付はどのみち frontmatter の `proposed_at_commit` と git 履歴から辿れるため、
  ファイル名の prefix は冗長という見方は成立する。その場合、本提案は reject して
  propose.md の文言修正（distribution 変更）を別提案にするのが筋になる。
- warn を fail に昇格させない設計は「出続けるが誰も直さない警告」になりやすい。
  既存 2 ファイルが warn を出し続けることが確定しており、ノイズとして
  `aro proposals check` の出力の信頼性（warn = 見るべきもの）を下げる懸念がある。
- 提案ファイルは AI（propose.md / 収穫スキル）が書くものであり、プロンプト側の指示で
  十分に規約が守られるなら機械検証は過剰、という判断もありうる。ただし今回の乖離は
  まさにプロンプトを経由しない書き手（収穫スキル）で起きたものではある。
