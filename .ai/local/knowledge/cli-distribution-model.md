# ARO CLIとdistributionの境界

正本は `packages/aro-cli/src/main.ts`、`packages/aro-cli/package.json`、`docs/distribution.md`。
本書はそこから導いた索引・要約であり、正本を置き換えない。

## CLIの表面

`buildProgram()`が登録するcommand familyは次のとおり。

- 配布・同期: `init` / `diff` / `sync` / `doctor`
- 変更検証: `guard`
- repo固有状態: `knowledge` / `proposals` / `plans`

CLI versionは`packages/aro-cli/package.json`から導出し、distribution versionとは独立している。
`@ai-repo-ops/aro-cli`は現在private packageで、Node.js 20以上を要求する。

## distribution strategy

`distribution/<name>/manifest.yaml`が対象repoへ配布する内容を宣言する。strategyは3種類に限定される。

- `managed_overwrite`: 中央管理。consumer側で直接編集せず、`aro sync`で更新する。
- `create_only`: 対象が無い初回だけ生成し、以後のsyncでは上書きしない。`.ai/project.yaml`とCI caller workflowが該当する。
- `append_unique_lines`: `.gitignore`などへ不足行だけを追加し、既存行やコメントを維持する。

`.ai/local/**`は常時保護され、distributionから書き込めない。distributionが配るのはlocal stateそのものではなく、
それを扱うprompt、schema、policyである。checkerはCLIまたは中央reusable workflowが実行する。

## versionと更新判定

manifest versionは人間向けのrelease表示であり、更新判定の正ではない。`aro diff` / `aro sync`は
manifest、配布source、patchを正規化した`distribution_content_sha256`をlockと比較する。同じversionでも
content hashが変わればdriftとして検出する。

`create_only` sourceの変更もdistribution content hashには含まれるが、既存consumerのseed fileは
自動更新されない。CI callerは生成後にrepo固有のtrust policyを保持し、中央更新への追従はcallerが参照する
reusable workflowのrefによって行う。
