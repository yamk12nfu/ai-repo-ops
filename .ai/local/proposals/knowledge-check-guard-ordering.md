---
schema_version: 1
id: knowledge-check-guard-ordering
status: done
decision:
  by: yamk12nfu
proposed_at_commit: dacda46b96c2dcdaef51d99528e238b2dde9d2a9
sources:
  - path: "docs/repo-knowledge-loop.md"
  - path: "README.md"
---

## 提案: 「knowledge 更新は check → 人間確認 → commit → guard の順序が必須」の knowledge entry

タイトル案: 「guard は未 commit 差分を検査しない — knowledge 更新フローの順序制約」

`aro guard` は base と HEAD の diff（merge-base 比較）だけを検証し、未 commit の
working tree 差分を一切見ない。そのため knowledge 更新では、未 commit のまま
`aro knowledge check --strict` → 人間の差分確認 → commit → `aro guard` の順序が必須で、
逆順（commit 前に guard）だと knowledge 変更を何も検証しないまま guard が緑になる。

非自明な点: 個々のコマンドは正しく動いているのに、順序を誤ると「guard が通った」という
誤った安心だけが残ること。特に PR レビューで検証結果の報告を読む側は、guard が
commit **後**に実行されたかを確認する必要がある。`knowledge init` の成功出力はこの順序を
launcher・絶対 path・検証済み base SHA 付きの完全コマンドで提示するため、出力があるときは
それを優先する規約になっている（docs/repo-knowledge-loop.md「ローカル更新ループ」、
README の `aro knowledge` / `aro guard` 節が根拠）。2026-08-09 の ai-repo-ops 自身への
Knowledge Loop 自己導入（初回 entry `operating-model` 作成）で、実際にこの順序で完走した。
