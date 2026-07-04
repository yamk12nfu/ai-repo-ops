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
- バージョンの契約は 2 層に分かれる。リリースのたびに整合を確認する。
  - `package.json`（root）と `packages/aro-cli/package.json` の `version` は**常に一致**させる
    （リリースバージョンそのもの。§5 で bump する）。
  - `distribution/base/manifest.yaml` の `version` は上記 2 つとは別軸で、**distribution の内容が
    変わったリリースでのみ**更新する（変更が無いリリースでは bump しない。詳細は §4 参照）。
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
pnpm aro doctor --repo "$SMOKE_REPO"; echo "doctor exit=$?"
pnpm aro diff --repo "$SMOKE_REPO" --detailed-exitcode; echo "diff exit=$?"
pnpm aro sync --repo "$SMOKE_REPO"; echo "sync exit=$?"

# 4. 後片付け
rm -rf "$SMOKE_REPO"
```

**合格基準**（いずれか 1 つでも満たさなければリリースを止めて原因調査する）:

- `aro doctor` の出力に `FAIL` が 1 件も無い（上の `doctor exit=$?` が **`0`**）。
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

1. 次のファイルの `version` を新しいリリースバージョン（`X.Y.Z`）に揃えて更新する。
   - `package.json`（root）
   - `packages/aro-cli/package.json`
   - `distribution/base/manifest.yaml` — **§4 で distribution に変更があると判定した場合のみ**。
     すでに §4 で bump 済みならここでの追加作業は無い（bump し忘れていた場合はここで行う）。
2. [`CHANGELOG.md`](./CHANGELOG.md) を編集する（[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 形式）。
   - `## [Unreleased]` の内容を `## [X.Y.Z] - YYYY-MM-DD`（リリース日）の新セクションへ切り出す。
   - `## [Unreleased]` セクションは空のまま残す（次のリリースまでの変更を追記していく場所）。
   - ファイル末尾の比較リンク（`[Unreleased]: .../compare/vX.Y.Z...HEAD` /
     `[X.Y.Z]: .../tree/vX.Y.Z`）を追加・更新する（GitHub Releases は発行しないため、タグだけで
     解決できる `tree/vX.Y.Z` へのリンクにする。§7 参照）。
3. §4 の version 一致を再確認する: `package.json` / `packages/aro-cli/package.json` /
   `distribution/base/manifest.yaml`（distribution に変更があった場合のみ）の `version` と、
   `CHANGELOG.md` に追記した version が一致していること。
4. 変更したファイルを commit する。**§4 で `distribution/base/manifest.yaml` を編集した場合は、
   version bump commit に必ず含める**（別 commit・別タイミングに分けると、実際にタグが指す commit に
   manifest bump が入らず、§4 での作業が無かったことになってしまう）。

   ```bash
   git add package.json packages/aro-cli/package.json CHANGELOG.md
   # distribution/base/manifest.yaml を編集した場合（§4）は必ず追加する
   git add distribution/base/manifest.yaml
   git commit -m "chore(release): bump version to X.Y.Z"
   ```

5. commit 後、タグ発行前にもう一段の自動検証を行う（上記 3. の手動再確認を機械的に裏付ける）。

   ```bash
   pnpm release:check --pre-tag
   ```

   - `--pre-tag` を付けるのは、この時点ではまだ `vX.Y.Z` / `v1` タグを発行していないため
     （タグ発行後の検証項目は §7 で `--pre-tag` 無しで実行する）。
   - チェック内容: `package.json`（root）と `packages/aro-cli/package.json` の `version` 一致・
     `distribution/base/manifest.yaml` の `version` が semver 形式であること・`CHANGELOG.md` に
     該当 version のセクションが存在すること。
   - 1 つでも FAIL があれば、該当箇所（1.〜4.）を修正してからやり直す。

## 6. タグ発行 → `v1` 移動 → push

（例: 初回リリースでは `vX.Y.Z` = `v0.1.0`。以下の `vX.Y.Z` は実際のバージョン文字列に置き換える。
moving tag の扱いは §1 で判定した「通常のリリース」か「`v2` への切り上げリリース」かで分岐する。
**下の 2 パターンのうち該当する方だけを実行する（両方実行しない）**。）

まず共通の手順（不変タグの発行と push）を行う。

```bash
# 1. リリース対象 commit（通常は上記 version bump commit）の SHA を確認
RELEASE_SHA="$(git rev-parse HEAD)"

# 2. 不変タグを発行して push する
git tag vX.Y.Z "$RELEASE_SHA"
git push origin main
git push origin vX.Y.Z
```

続いて moving tag を、リリース種別に応じてどちらか一方だけ実行する。

**通常のリリース**（reusable workflow に破壊的変更が無い。§1 参照）: `v1` を今回の commit へ付け替える。

```bash
git tag -f v1 "$RELEASE_SHA"
git push -f origin v1
```

**`v2` への切り上げリリース**（§1 の破壊的変更に該当する場合のみ）: `v1` には一切触れず、`v2` を
新規発行する。

```bash
git tag v2 "$RELEASE_SHA"
git push origin v2
```

## 7. リリース後確認

```bash
pnpm release:check
```

- `--pre-tag` を付けずに実行する（§5 と異なり、この時点では `vX.Y.Z` / moving tag が発行済み）。
- 検証内容: §5 の a〜c（version 整合・CHANGELOG）に加え、`vX.Y.Z` タグが origin に存在すること、
  および配布中の `ai-review.yml` / `ai-improve.yml` が参照する moving tag（通常 `v1`）が origin の
  `vX.Y.Z` と同じ commit を指すこと。1 つでも FAIL があれば、moving tag の付け替え漏れ等
  §6 の手順に戻って修正する（`git ls-remote --tags origin` で生の tag 一覧も直接確認できる）。
- 可能であれば、`aro init` 済みの実 repo で PR を作成し `AI Review` workflow が緑で完了すること、
  および `AI Improve` workflow を `workflow_dispatch` から起動して緑で完了することを確認する
  （中身は stub の echo のままでよい。動くこと自体の確認）。

### GitHub Releases は発行しない（決定事項）

`v0.1.0` はタグ（`v0.1.0` / `v1`）のみを発行し、GitHub Releases は作成しない。`CHANGELOG.md` が
リリースノートの役割を兼ねる（そのため CHANGELOG 内の各バージョンへのリンクも
`releases/tag/vX.Y.Z` ではなく、タグだけで解決できる `tree/vX.Y.Z` にしている）。以降のリリースで
リリースノートの公開が必要になった場合は、その時点で `gh release create vX.Y.Z --notes-file ...`
等による発行を再検討する。

## リスク / 未決事項

- **moving tag（`v1`）の付け替え忘れ**: `v1` の force-push を忘れると、「`vX.Y.Z` を出したのに対象 repo
  は古い reusable workflow のまま」という静かなズレが発生する（対象 repo 側は `@v1` を解決するだけなので
  中央側の tag 移動漏れに気づけない）。**自動化済み**（`pnpm release:check`。実体は
  [`scripts/release-check.mjs`](./scripts/release-check.mjs)）。§5 では `--pre-tag` 付きで
  version/CHANGELOG 整合のみを、§7 ではフルで origin タグの整合まで検証する。検証項目:
  - `package.json` / `packages/aro-cli/package.json` の `version` 一致（`distribution/base/manifest.yaml`
    は §0 の 2 層契約により別軸のため、semver として妥当かのみ確認し一致は求めない）
  - `CHANGELOG.md` に該当 version のセクションが存在すること
  - `vX.Y.Z` タグが origin に存在すること
  - 配布中の `ai-review.yml` / `ai-improve.yml` が参照する moving tag（通常 `v1`）が、期待する commit
    （＝最新の `vX.Y.Z` タグと同じ commit）を指していること
- **GitHub Releases の発行有無**: `v0.1.0` はタグのみで発行し GitHub Releases は作らないと決定済み
  （§7）。以降のリリースでリリースノート公開が必要になれば再検討する。
