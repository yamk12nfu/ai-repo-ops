# knowledge 更新の検証順序

正本は `docs/repo-knowledge-loop.md` と `README.md`。本書はそこから導いた索引・要約であり、
正本を置き換えない。

## guard が検証する範囲

`aro guard --repo . --base <base>` は、`<base>` と `HEAD` の merge-base から、commit 済みの
`HEAD` までの差分を検証する。working tree の未commit差分は検証対象に含まれないため、
knowledge 更新をcommitする前に guardを実行しても、その更新自体は検証されない。

## 必須の順序

1. 未commitのworking treeに対して `aro knowledge check --repo . --strict` を実行する。
2. 人間がknowledgeの差分と根拠をレビューする。
3. knowledge変更をcommitする。
4. commit済みの `base..HEAD` を `aro guard --repo . --base <base>` で検証する。

PRはguard成功後に作成し、mergeは人間の確認後に行う。`knowledge init` の成功出力にlauncher、
対象repoの絶対path、検証済みbase SHAを含む完全な後続コマンドがある場合は、その案内を優先する。
