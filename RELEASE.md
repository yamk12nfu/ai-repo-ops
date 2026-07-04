# RELEASE

`ai-repo-ops` のリリース手順書。このドキュメントだけを読めば、このリポジトリの実装に詳しくない人（または
AI）でもリリース作業を再現できることを目的とする。前提知識は最小限（git・pnpm の基本操作）とし、
判断が必要な箇所には具体的な判定基準を書く。

## 0. 前提

- pnpm workspace。root `ai-repo-ops`（private・npm 非公開）と `packages/aro-cli`
  （`@ai-repo-ops/aro-cli`）から成る。詳細は [`README.md`](./README.md) を参照。
- リモートは `origin` = `github.com:yamk12nfu/ai-repo-ops`。
- リリースの起点は `main` ブランチの HEAD（作業ブランチで作業していた場合は先に PR を merge しておく。
  merge 後にローカル `main` を最新へ追従させる手順は §5 冒頭を参照）。
- バージョン番号は次の 3 箇所に**同じ値**を持たせる。リリースのたびに整合を確認する。
  - `package.json`（root）の `version`
  - `packages/aro-cli/package.json` の `version`
  - `distribution/base/manifest.yaml` の `version`（distribution の内容が変わった時だけ意味を持つ。
    詳細は §4 参照）
- 特に断りが無い限り、以下のコマンドはすべてこのリポジトリの root ディレクトリで実行する。

## 1. タグ戦略

- **`vX.Y.Z`**: semver に従う**不変**タグ。リリースのたびに新しい commit へ新しく発行する。一度発行した
  `vX.Y.Z` は再利用・移動しない。
- **`v1`**: major 1 系の**moving tag**。`distribution/base/files/.github/workflows/*.yml` が参照する
  reusable workflow（`.github/workflows/ai-review.reusable.yml` / `ai-improve.reusable.yml`）の互換ラインを
  指す。互換性を壊さないマイナー・パッチリリースのたびに、最新の `vX.Y.Z` と同じ commit へ**付け替える**。

  ```bash
  git tag -f v1 <release-sha>
  git push -f origin v1
  ```

- **`v2` への切り上げ**: 次のいずれかに該当する変更（reusable workflow の破壊的変更）を行う場合は、
  `v1` を付け替えず新たに `v2` を切る。
  - reusable workflow（`ai-review.reusable.yml` / `ai-improve.reusable.yml`）の `on.workflow_call.inputs`
    の削除・必須化・型変更など、既存の呼び出し側（配布済み `ai-review.yml` / `ai-improve.yml`）が
    そのままでは動かなくなる変更
  - distribution の互換性を壊す変更（`aro doctor` が要求するファイル形式・permission 要件の
    後方非互換な変更など）
  - `v2` を切ったら、`distribution/base/files/.github/workflows/ai-review.yml` /
    `ai-improve.yml` 内の `uses: .../ai-review.reusable.yml@v1` を `@v2` に書き換え、通常のリリース
    （本手順）で配布し、対象 repo は `aro sync` を実行することで新しい参照へ追従する。
  - 移行期間中は `v1` と `v2` の reusable workflow 実体を両方 main 上に残し、`v1` 系を参照している
    既存の対象 repo が壊れないようにする。

## 2. リリース前チェック（自動検証）

リポジトリ root で実行する。1 つでも失敗したら原因を修正してからやり直す。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm schema:check    # authoritative schema と配布用コピーの drift チェック
pnpm typecheck
pnpm build
pnpm test
```

（この 5 コマンドは CI（`.github/workflows/ci.yml`）が Node 20 / 24 で実行しているものと同じ。
PR がすでに green ならこの節は再確認のみでよい。）

## 3. 手動受け入れテスト（使い捨て repo）

`aro init → doctor → diff → sync` の一連の流れが、実際の git repo に対して問題なく通ることを確認する。
このリポジトリ自身ではなく、使い捨ての別 repo に対して行う。

```bash
# 1. 使い捨て repo を用意する（git repo であればよい。commit は不要）
SMOKE_REPO="$(mktemp -d)"
git -C "$SMOKE_REPO" init -q

# 2. ai-repo-ops root で最新の CLI をビルドする（§2 を先に実行済みなら不要）
pnpm build

# 3. init → doctor → diff → sync を通す
pnpm aro init --repo "$SMOKE_REPO"
pnpm aro doctor --repo "$SMOKE_REPO"
pnpm aro diff --repo "$SMOKE_REPO" --detailed-exitcode; echo "diff exit=$?"
pnpm aro sync --repo "$SMOKE_REPO"; echo "sync exit=$?"

# 4. 後片付け
rm -rf "$SMOKE_REPO"
```

**合格基準**（いずれか 1 つでも満たさなければリリースを止めて原因調査する）:

- `aro doctor` の出力に `FAIL` が 1 件も無い（終了コード `0`）。
- `aro diff --detailed-exitcode` の終了コード（上の `diff exit=$?`）が **`0`**
  （`init` 直後は distribution と repo が完全に一致しているはずなので、差分は無いのが正しい）。
- `aro sync` が conflict なく完了する（終了コード `0`。`init` 直後で差分が無いため
  「up to date」として即完了するのが期待される挙動であり、これはこの smoke test では
  「sync 自体がエラーなく走ること」の確認が目的）。

## 4. distribution の version bump 確認

直前のリリースタグ以降で `distribution/` 配下（`distribution/base/manifest.yaml` および
`distribution/base/files/**`）に変更があるか確認する。

```bash
git diff <直前の vX.Y.Z タグ>..HEAD -- distribution/
```

- 差分が**ある**場合: `distribution/base/manifest.yaml` の `version` を上げる。
- 差分が**無い**場合: `manifest.yaml` の `version` はそのままでよい。

> 補足: `aro diff` / `aro sync` の更新判定はファイルの canonical checksum で行われるため
> （[`docs/sync-strategy.md`](./docs/sync-strategy.md) 参照）、`manifest.yaml` の `version` bump 忘れは
> 対象 repo の動作自体には影響しない。しかし「どの distribution 内容がどのリリースで配られたか」を
> 追跡可能にするため、**リリース時は bump を必須のルールとする**。

（初回リリース `0.1.0` には「直前の `vX.Y.Z` タグ」が存在しないため上記の `git diff` は実行できないが、
`manifest.yaml` はすでに `version: 0.1.0` になっており追加の bump 作業は不要。次回以降のリリースから
この節が意味を持つ。）

## 5. package.json の version bump / CHANGELOG 追記

作業ブランチで PR を作っていた場合、GitHub 上で merge しただけではローカルの `main` は追従しない
（ローカル `main` は merge 前の古い commit を指したまま）。この状態で version bump commit を作ると、
意図しない（＝実際に merge された内容と異なる）commit の上にタグを付けてしまう、あるいは push 時に
「remote に無い分岐」として reject される。**version bump commit を作る前に、必ずローカル `main` を
`origin/main` の最新へ追従させる。**

```bash
git checkout main
git pull origin main
```

1. 次の 2 ファイルの `version` を新しいリリースバージョン（`X.Y.Z`）に揃えて更新する。
   - `package.json`（root）
   - `packages/aro-cli/package.json`
2. [`CHANGELOG.md`](./CHANGELOG.md) を編集する（[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 形式）。
   - `## [Unreleased]` の内容を `## [X.Y.Z] - YYYY-MM-DD`（リリース日）の新セクションへ切り出す。
   - `## [Unreleased]` セクションは空のまま残す（次のリリースまでの変更を追記していく場所）。
   - ファイル末尾の比較リンク（`[Unreleased]: .../compare/vX.Y.Z...HEAD` /
     `[X.Y.Z]: .../releases/tag/vX.Y.Z`）を追加・更新する。
3. §4 の version 一致を再確認する: `package.json` / `packages/aro-cli/package.json` /
   `distribution/base/manifest.yaml`（distribution に変更があった場合のみ）の `version` と、
   `CHANGELOG.md` に追記した version が一致していること。
4. 上記の変更を commit する（例: `chore(release): bump version to X.Y.Z`）。

## 6. タグ発行 → `v1` 移動 → push

（例: 初回リリースでは `vX.Y.Z` = `v0.1.0`。以下の `vX.Y.Z` は実際のバージョン文字列に置き換える。）

```bash
# 1. リリース対象 commit（通常は上記 version bump commit）の SHA を確認
RELEASE_SHA="$(git rev-parse HEAD)"

# 2. 不変タグを発行する
git tag vX.Y.Z "$RELEASE_SHA"

# 3. v1（moving tag）を同じ commit へ付け替える
#    （v2 に切り上げるリリースの場合は代わりに v2 を新規発行し、v1 は動かさない。§1 参照）
git tag -f v1 "$RELEASE_SHA"

# 4. まとめて push（tag の push は明示的に指定しないと送られない）
git push origin main
git push origin vX.Y.Z
git push -f origin v1
```

## 7. リリース後確認

```bash
git ls-remote --tags origin
```

- `vX.Y.Z` と `v1` の両方が表示され、`v1` が今回発行した `vX.Y.Z` と同じ commit SHA を指していることを
  確認する。
- 可能であれば、`aro init` 済みの実 repo で PR を作成し `AI Review` workflow が緑で完了すること、
  および `AI Improve` workflow を `workflow_dispatch` から起動して緑で完了することを確認する
  （中身は stub の echo のままでよい。動くこと自体の確認）。

### GitHub Releases として発行するか（未決事項）

タグ発行のみで済ますか、GitHub Releases（`gh release create vX.Y.Z --notes-file ...` 等でリリースノートを
公開）まで行うかは、初回リリース（`0.1.0`）実施時に判断する。本ドキュメントでは手順を固定せず、
判断が決まり次第この節を更新する。

## リスク / 未決事項

- **moving tag（`v1`）の付け替え忘れ**: `v1` の force-push を忘れると、「`vX.Y.Z` を出したのに対象 repo
  は古い reusable workflow のまま」という静かなズレが発生する（対象 repo 側は `@v1` を解決するだけなので
  中央側の tag 移動漏れに気づけない）。初回リリースは本ドキュメントの手動チェックリスト（§6・§7）で
  防ぎ、**2 回目のリリース前に `release:check` スクリプトとして自動化する予定**（未実装。本リリースの
  スコープ外）。想定する検証項目:
  - `package.json` / `packages/aro-cli/package.json` / `distribution/base/manifest.yaml` の `version` 一致
  - `CHANGELOG.md` に該当 version のセクションが存在すること
  - `vX.Y.Z` タグがリモートに存在すること
  - `v1` タグが期待する commit（＝最新の `vX.Y.Z` タグと同じ commit）を指していること
- **GitHub Releases の発行有無**: 上記の通り未決。初回リリース実施時に判断する。
