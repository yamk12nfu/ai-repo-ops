# 計画 01: リリース基盤 — `v0.1.0` / `v1` タグとリリース手順

優先度: **最優先（破損修正）** / 前提: なし / 規模: 小（実装コードの変更なし）

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| 対象 repo の workflow | `aro init` した repo で PR を開くと、`@v1` が解決できず **workflow が失敗する** | PR を開くと `ai-review.yml` が起動し正常終了する（中身は stub のまま） |
| 中央の状態の指名 | 「どの時点の distribution を配ったか」を指す名前がない | `v0.1.0` で状態を固定し、reusable workflow の互換ラインを `v1` で指せる |
| リリース作業 | 手順が存在しない（属人化以前に未定義） | `RELEASE.md` のチェックリストに従えば誰でも（AI でも）再現できる |
| 位置づけの明示 | README を読んでも「AI 実行基盤がまだ stub」であることが分かりにくい | README に「配布・診断 MVP であり、AI 実行はまだ stub」と明記される |

## 現状とギャップ

- `distribution/base/files/.github/workflows/ai-review.yml:14` と `ai-improve.yml:15` は
  `yamk12nfu/ai-repo-ops/.github/workflows/*.reusable.yml@v1` を参照する。
- しかし `git ls-remote --tags origin` は空。**`v1` はローカルにもリモートにも存在しない。**
- reusable workflow の実体（`.github/workflows/ai-review.reusable.yml` / `ai-improve.reusable.yml`）は
  main に存在するが、タグが無いため対象 repo からは参照できない。
- `package.json` / `distribution/base/manifest.yaml` はともに `version: 0.1.0` だが、
  bump のタイミング・リリースとの対応が未定義。

## スコープ

- タグ戦略の決定と初回タグ発行
- `RELEASE.md`（リリースチェックリスト）と `CHANGELOG.md` の作成
- README への位置づけ明記

## 非スコープ

- npm publish / tarball 配布（→ 計画 04）
- reusable workflow の実装（→ 計画 02 / 03。本計画では stub のまま「起動する」ことだけ保証する）

## 実装タスク

1. **タグ戦略を決めて docs 化する**（`RELEASE.md` 内に記載）
   - `vX.Y.Z`: 不変の semver タグ。リリースごとに発行。
   - `v1`: major 1 系の **moving tag**。reusable workflow の互換ライン。リリース時に
     `git tag -f v1 <release-sha> && git push -f origin v1` で移動する。
   - 破壊的変更（reusable workflow の inputs 変更・distribution の互換性破壊）時は `v2` を切り、
     配布側 workflow の参照を更新して sync で行き渡らせる。
2. **`CHANGELOG.md` を作成する**（Keep a Changelog 形式、`0.1.0` に MVP の内容を記載）
3. **`RELEASE.md` を作成する**。チェックリスト:
   - `pnpm install --frozen-lockfile` / `pnpm schema:check` / `pnpm typecheck` / `pnpm build` / `pnpm test`
   - 手動受け入れ: 使い捨て repo に `aro init → doctor → diff → sync` を通し、
     `doctor` が FAIL なし・`diff --detailed-exitcode` が 0 で終わることを確認
   - distribution の内容が変わっている場合は `distribution/base/manifest.yaml` の `version` bump を確認
     （更新判定自体は content hash なので bump 忘れは動作に影響しないが、リリース時は bump を必須とする）
   - `package.json` の version bump / CHANGELOG 追記
   - `vX.Y.Z` タグ発行 → `v1` 移動 → push
4. **README に位置づけを 1 段落追記する**:
   「現時点の `ai-review` / `ai-improve` workflow は文脈を echo する stub であり、
   本ツールは AI 運用基盤の**配布・更新・診断**を担う。AI 実行本体は Post-MVP（計画 02 / 03）」
5. **初回リリースを実施する**: 現 main を `v0.1.0` としてタグ付けし、`v1` を同じ commit に付けて push

## 受け入れ条件（DoD)

- [ ] `git ls-remote --tags origin` に `v0.1.0` と `v1` が表示される
- [ ] `aro init` 済みの実 repo で PR を開くと `AI Review` workflow が**緑**で完了する（stub の echo が実行される）
- [ ] 同 repo で `AI Improve` workflow を `workflow_dispatch` から起動して緑で完了する
- [ ] `RELEASE.md` の手順だけを見て、リポジトリ知識のない人（または AI）がリリース作業を再現できる
- [ ] README に stub である旨の明記がある

## リスク / 未決事項

- **moving tag (`v1`) の force-push 運用**は GitHub Actions の reusable workflow 参照では一般的だが、
  タグの付け替えを忘れると「`v0.2.0` を出したのに対象 repo は古い workflow のまま」という
  静かなズレが起きる。**初回リリースは `RELEASE.md` の手動チェックリストで防ぎ、
  2 回目のリリース前に `release:check` スクリプトとして自動化する。** 検証項目:
  `package.json` / `packages/aro-cli/package.json` / `distribution/base/manifest.yaml` の version 一致、
  CHANGELOG に該当 version の記載、`vX.Y.Z` タグの存在、`v1` が期待 commit を指していること。
- リリースを GitHub Releases として発行するか（タグのみで済ますか）は初回リリース時に判断。
