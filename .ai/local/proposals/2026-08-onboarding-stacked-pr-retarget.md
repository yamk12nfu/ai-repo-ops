---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: 2026-08-onboarding-stacked-pr-retarget
status: accepted
decision:
  by: "yamk12nfu"
proposed_at_commit: 86ef5911409da8c47fdd28113d892f8a07595de3
sources:
  - path: "docs/onboarding.md"
---

## 提案: 「onboarding 手順②を手順① PR に stack すると main に届かない事故が起きる」の knowledge entry

タイトル案: 「onboarding の PR ①②は stack しない — base 自動 retarget は head ブランチ削除時にしか働かない」

docs/onboarding.md は手順 1（`aro init` PR）と手順 2（`project.yaml` 調整 PR）を分けることを
求めているが、待ち時間短縮のため手順②を手順① PR の上に stacked PR（base = ①の head ブランチ）
として先に作る運用は自然に思いつく。このとき GitHub の base 自動 retarget は「① の merge 時に
head ブランチが削除された場合」にしか働かないため、ブランチを残したまま ①→② の順で merge すると
② は削除されなかった旧 head ブランチへ merge され、**両 PR とも MERGED 表示なのに main に設定変更が
届かない**。`git pull` が "Already up to date" を返すため気づきにくく、発覚は doctor / guard の
挙動が期待とずれた時になる。

非自明な点: 事故の有無が PR の作り方ではなく「merge 時に head ブランチを削除したか」という
merge 操作側の一手に依存すること。2026-08-11 の mdlog-mcp 導入で実際に発生し
（PR #3 が chore/aro-init へ merge され、同一コミットを main へ cherry-pick する PR #4 で復旧）、
onboarding どおり順次 PR にするか、stack する場合は ① merge 時の head ブランチ削除を必須にする
運用が必要。docs/onboarding.md の手順 1〜2 にはこの注意書きがまだ無い。
