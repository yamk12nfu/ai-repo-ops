# 対象 repo への導入と init 後の調整（onboarding）

`aro init` から運用開始までの標準手順。dogfooding（my-tasks / warikapp、
[issue #22](https://github.com/yamk12nfu/ai-repo-ops/issues/22)）で 2/2 の repo が
init 初期値のままでは運用に入れなかったため、**「init 後の `.ai/project.yaml` 調整」を
導入の標準ステップとして扱う**。

## 全体の流れ

1. `aro init` → 生成物をそのまま commit → PR → merge（この PR では調整しない）
2. `.ai/project.yaml` を repo 実態に合わせて調整 → 設定専用 PR → **override merge**（下記）
3. `aro knowledge init` → 初回 knowledge entry の作成 → PR
4. 以後、ローカル改善ループ（[`local-improve-loop.md`](./local-improve-loop.md)）と
   knowledge loop（[`repo-knowledge-loop.md`](./repo-knowledge-loop.md)）を運用

手順 1 と 2 の PR を分けるのは、guard の `project_config` violation を「設定変更だけの
diff」に対して出させ、人間が確認する範囲を最小にするため。

## 手順 1: `aro init` と初回 commit

```bash
aro init --repo /path/to/target-repo
aro doctor --repo /path/to/target-repo   # FAIL が無いことを確認（WARN は後述）
```

- 生成物は**調整せずそのまま** commit して PR にする（README「使い方」の推奨どおり、
  I/O 失敗からの復旧可能性のためにも init 直後の commit が重要）。
- この時点の `aro doctor` は `commands.*` が空であることによる WARN を出す。これは
  init が言語 / FW を知らないための仕様であり、手順 2 で解消する。

## 手順 2: `.ai/project.yaml` の調整（事実上必須）

init の初期値は意図的に汎用値になっており、実際の repo とは乖離することが多い。
dogfooding では次の乖離を確認している。

| 項目 | 初期値 | 実際の repo の例 |
|---|---|---|
| `ai.allowed_paths` | `src/**` `tests/**` `docs/**` | Next.js App Router: `app/**` `convex/**`。ドキュメント repo: `articles/**` `note/**` など |
| `commands.*` | すべて空 | `npm run lint` / `npx tsc --noEmit` / `npm run build` など |
| `quality_gates.required` | `lint` `test` | テスト未整備なら `test` を外す（空コマンドを required にしない） |

調整の指針:

- **`allowed_paths` は実際にコードが置かれている path に合わせる**。存在しないディレクトリ
  （`src/` の無い repo の `src/**` など）を残しても害は少ないが、実コンテンツの path が
  無いと改善ループが何も変更できない。
- **root 直下の設定ファイル（`eslint.config.mjs` / `package.json` 等）を改善ループの対象に
  したい場合は、glob ではなく個別ファイル名で明示的に列挙する**。`*` のような広い glob は
  `.env` 等を巻き込むリスクがあるため使わない（`forbidden_paths` が最後の防壁になるが、
  allowed 側を狭く保つのが原則）。列挙しない場合、root 設定ファイルの修正は改善ループの
  対象外となり、人間の手作業になる（これは意図的な選択として妥当）。
- **`commands.*` は、実際にその repo で実行して緑になることを確認してから書く**。
  動かないコマンドを書くと、改善ループの自己検証が常に失敗する。
- `quality_gates.required` の各要素は `commands` のキーを指す。**空のコマンドを required に
  しない**（例: テスト未整備なら `test` を required から外し、テスト導入時に戻す）。
- `project.type` / `project.owner` / `project.risk_level` も実態に合わせる。`risk_level` は
  適用 policy（`low-risk` / `default` / `security`）を決めるため特に重要。

## 手順 2 の merge: guard は fail するのが正常（override merge）

`.ai/project.yaml` は guard の検証ルールそのものを定めるファイルのため、変更 PR は
**必ず** `project_config` violation（および通常 `outside_allowed_paths`）で required check が
落ちる。これは異常ではなく、「設定変更は人間が必ず見る」ための設計である
（[`guard.md`「project_config の扱い」](./guard.md)）。

merge 手順:

1. PR の diff を人間が確認する（allowed_paths の広がり・forbidden_paths の削除・
   `risk_level` の引き下げなど、guard を弱める方向の変更に特に注意する）
2. 確認できたら **明示的に override して merge する**（GitHub では admin merge、
   または branch protection の「Require status checks」の手動 bypass）
3. PR 本文に「guard は project_config により意図的に fail している」旨を書いておくと、
   後から見た人が required check の赤を誤読しない

## 手順 3: knowledge の初期化

設定 PR の merge 後に実行する（`.ai/local/knowledge/**` が allowed_paths に含まれて
いることが前提。init 初期値には含まれている）。

```bash
aro knowledge init --repo /path/to/target-repo --base origin/main
aro knowledge check --repo /path/to/target-repo --strict
```

初回 entry の作成は `.ai/managed/prompts/knowledge-refresh.md` の手順に従う
（変化しにくい正式文書だけを根拠にする。詳細は
[`repo-knowledge-loop.md`](./repo-knowledge-loop.md)）。

## 既知の制約（運用データ収集中）

- **project type 別の init 初期値**（Next.js なら `app/**` を含める等）は未実装。
  現状は本ガイドの手順 2 で吸収する（[issue #22](https://github.com/yamk12nfu/ai-repo-ops/issues/22) 論点 1）。
- スキャフォールド直後などコードの少ない repo では、改善ループの in-scope な改善候補が
  枯れやすい。その期間は knowledge loop の運用が主になる。
