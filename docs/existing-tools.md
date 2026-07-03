# Existing Tools（Copier / Cruft との関係）

テンプレートからプロジェクトを生成し、テンプレート更新に追従させるという意味で、`ai-repo-ops` は [Copier](https://copier.readthedocs.io/) や [Cruft](https://cruft.github.io/cruft/) と同じ問題領域にある。このドキュメントは、それでも MVP で自作する理由と、将来の再評価ポイントを明記する。

## Copier / Cruft が解いている問題

```txt
テンプレートからプロジェクトを生成する
生成済みプロジェクトをテンプレート更新に追従させる
テンプレート由来の差分とプロジェクト側の差分を扱う（3-way merge）
template repository の version やcommit を追跡する
一部ツールは conflict 時に .rej やinline conflict marker を出せる
```

いずれも汎用テンプレートエンジンとして成熟しており、任意言語・任意プロジェクト構造に対応する。

## それでも MVP で自作する理由

`ai-repo-ops` の MVP は汎用テンプレートエンジンではなく、AI 運用基盤専用の薄い配布・検証ツールとして自作する。

```txt
1. TypeScript / Node.js で ai-repo-ops 全体（CLI・将来の harness・telemetry・GitHub Actions 連携）を統一したい
2. 配布対象が prompts / policies / workflow / schema に限定される（Copier ほどの汎用性が不要）
3. 既存 repo へ部分的に overlay したい（Copier は「テンプレートからプロジェクト全体を生成する」思想に近い）
4. .ai/managed / .ai/local / runtime の境界を強制したい（AI 運用基盤特有の設計原則）
5. checksum / lock / strategy を AI 運用基盤向けに単純化したい（managed_overwrite / create_only / append_unique_lines の 3 つに絞る）
6. 将来の AI harness / telemetry / GitHub Actions 連携と同じ CLI（aro）に統合したい
```

具体的には、Copier の 3-way merge・テンプレート変数の再質問・複雑な `_copier.yml` 設定は、AI 運用基盤ファイルの配布という狭い用途には過剰である。一方で `ai-repo-ops` は distribution content hash・orphaned managed file 検出・central reusable workflow 連携など、AI 運用基盤特有の検証（`aro doctor`）を持つ。これは汎用テンプレートエンジンの守備範囲外であり、自前実装のほうが素直に実現できる。

## MVP でのアーキテクチャ的な違い

| 観点 | Copier / Cruft | ai-repo-ops MVP |
| --- | --- | --- |
| 更新判定 | template の git commit / version | canonical checksum（`distribution_content_sha256`） |
| conflict 処理 | 3-way merge（`git merge-file` 等）、conflict marker 出力 | atomic abort（conflict が1件でもあれば一切変更しない） |
| 変数の再質問 | 対応（`_copier.yml` の questions） | 非対応（`.ai/project.yaml` は `create_only` で初回生成のみ） |
| 配布対象 | 任意のプロジェクト全体 | managed/seed file は `.ai/**` と `.github/workflows/**` に限定（`patches[]` は `.gitignore` / `.gitattributes` / `.prettierignore` など repo root の dotfile も追記対象にする） |
| 削除・rename 追従 | 対応 | 非対応（orphaned managed file を WARN するのみ） |

「人間が managed file を少し触ったら永久 conflict になる」問題は認識しているが、MVP では安全性（意図しない上書き・データ損失の防止）を優先し、3-way merge は実装しない。repo 固有の差分は `.ai/local/**` と `.ai/project.yaml` に逃がす設計にすることで、conflict そのものの発生を減らす方針を取る。

## 再評価ポイント

次のいずれかを実装する段階では、既存ツールをラップするか自前実装を継続するかを再評価する。

```txt
3-way merge
テンプレート変数の再質問・再生成
複数 version 間 migration
既存 repo への link/adopt
大規模 rollout
conflict marker / .rej 出力
```

MVP では、既存ツールの完全な再実装はしない。将来 3-way merge やテンプレート変数更新を広げる場合は、`git merge-file` を使った軽量な merge 支援から検討し、必要に応じて Copier / Cruft のラップを選択肢に入れる（`ai-repo-ops-implementation-plan-v3.md` §22 Post-MVP Phase A）。
