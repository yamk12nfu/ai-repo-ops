# onboarding の PR ①②は stack しない

正本は `docs/onboarding.md`。本書はそこから導いた索引・要約であり、正本を置き換えない。

## 事故条件

手順 2 の設定 PR を、手順 1 の `aro init` PR の head ブランチへ stack すると、PR ①の
merge 時にその head ブランチを残した場合、GitHub の base 自動 retarget が働かない。
そのまま PR ②を merge すると、両 PR が `MERGED` 表示でも設定変更が `main` に到達しないことがある。

## 安全な運用

原則として PR ①を merge してから、`main` を base に独立した PR ②を作る。stack が避けられない場合は、
PR ①の merge 時に head ブランチを削除し、PR ②の merge 前後で base と `main` への到達関係を明示的に
確認する。PR ②の merge 前に base が `main` でなければ停止し、base を `main` に retarget して diff を
再確認するか、`main` から PR ②を独立して作り直す。`MERGED` 表示だけを `main` 反映の証拠にしない。
