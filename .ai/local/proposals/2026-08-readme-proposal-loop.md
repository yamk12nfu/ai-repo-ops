---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: readme-proposal-loop-missing
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: 583edf848e5f76bb4b56eb8fd66e6e10ec0ebc7b
sources:
  - path: "README.md"
  - path: "docs/proposal-loop.md"
---

## 課題

README.md が v0.4.0 の主要機能である Proposal Loop に一切言及していない。具体的には:

- ステータス行（5 行目）は「MVP 完了 + `aro guard` + Repo Knowledge Loop」で止まっており、
  `aro proposals check` が実装済みであることが読み取れない。
- 「Documentation」節の一覧に `docs/proposal-loop.md`（運用手順書）が無い。
  `docs/repo-knowledge-loop.md` や `docs/local-improve-loop.md` は載っているため、
  一覧だけ読むと Proposal Loop が存在しないように見える。
- 「使い方（MVP）」のコマンド一覧（`init` / `diff` / `sync` / `doctor` / `guard` /
  `knowledge`）に `aro proposals check` が無い。

README はこの repo の入口であり、新しく参加する repo のオーナーや将来の自分が
機能の全体像を把握する起点になる。実装・手順書（docs/proposal-loop.md）・CHANGELOG は
揃っているのに入口だけが v0.3 時点の記述で止まっている。

## 提案

README.md に Proposal Loop の記述を追記する:

1. ステータス行に Proposal Loop / `aro proposals check` を追加する。
2. 「Documentation」一覧に `docs/proposal-loop.md` の行を追加する
   （一行要約: 提案・採否・実装を分離して回す運用手順書）。
3. 「使い方（MVP）」のコマンド一覧に `aro proposals check --repo /path/to/your-repo` を
   追加する。必要なら `### aro proposals check` の短い節（knowledge / guard の節と同じ粒度）を
   足し、詳細は docs/proposal-loop.md へ誘導する。

## 想定する変更範囲

- `README.md` のみ（1 ファイル）。`ai.max_changed_files: 10` に余裕で収まる。

## リスク・見送る理由になりうる点

- docs/proposal-loop.md と README の二重管理が増える。README 側を「一覧 + リンク + コマンド
  1 行」の最小限に抑えないと、次の機能追加でまた README だけ古くなる（今回と同じ構図の再発）。
- README のステータス行はすでに機能列挙が長く、追記を続ける方式自体が限界に近い。
  「機能列挙をやめて docs/ への参照に一本化する」全面改稿の方が根本的だが、それは
  変更が大きく別提案の規模になる。今回の追記を採用すると全面改稿の動機が下がる可能性がある。
- README を読む人が実際にどれだけいるか（owner 1 人の repo である現状では効果が
  限定的）という見方もできる。ただし fleet 展開（計画 05）を見据えるなら入口の整備は先行投資になる。
