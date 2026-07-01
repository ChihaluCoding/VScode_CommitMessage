# Commit Message Push

VS Code拡張です。ソース管理ツールバーの `commitMessage生成` ボタンで、ローカル CLI によるコミットメッセージ生成を行います。  
さらに、**この拡張で生成したメッセージでコミット成功した場合のみ** 自動で push を実行します。

## Features

- `scm/title`（ソース管理ツールバー）に `commitMessage生成` ボタンを追加
- プロバイダ切り替え対応: `codex`（`codex exec --json`）または `opencode`（`opencode run --format json`）
- 日本語1行コミットメッセージを生成
- 設定モデルが利用不可（アカウント権限/廃止など）の場合、候補を取得してフォールバック再試行
  - codex: `codex debug models` で取得し**性能が低い順**
  - opencode: `opencode models --verbose` で取得し **opencode-go のみ**を対象に**消費量が低くかつ早い順**（cost昇順 → flash/fast/mini 優先）
- 既定で、生成後に自動コミットを実行
- 生成メッセージと最新コミットの1行目が一致した場合のみ自動 push
- 自動 push は現在ブランチが `pushBranch` 設定値と一致したときのみ実行
- エラー時は通知し、`Output` の `Commit Message Push` チャンネルへログ出力

## Requirements

- VS Code
- 選択したプロバイダの CLI がインストール済みでログイン済み
  - `codex`: [Codex CLI](https://github.com/openai/codex)
  - `opencode`: [opencode CLI](https://opencode.ai)
- Git が利用可能

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `commitPush.provider` | string | `opencode` | プロバイダ。`codex` または `opencode` |
| `commitPush.model` | string | `gpt-5.4-mini` | `codex exec -m` に渡すモデル（provider=codex 時） |
| `commitPush.opencodeModel` | string | `opencode-go/deepseek-v4-flash` | `opencode run -m` に渡すモデル（provider=opencode 時）。`opencode-go/<model>` 形式 |
| `commitPush.reasoningEffort` | string | `high` | 推論強度。codex は `model_reasoning_effort`、opencode は `--variant` にマップ |
| `commitPush.includeUntracked` | boolean | `true` | 未追跡ファイル一覧をプロンプトに含める |
| `commitPush.diffMaxChars` | number | `12000` | 差分文字数上限。超過時は `[TRUNCATED]` 付与 |
| `commitPush.timeoutSeconds` | number | `90` | 生成タイムアウト秒数 |
| `commitPush.codexCommandPath` | string | `codex` | Codex CLI コマンドパス |
| `commitPush.opencodeCommandPath` | string | `opencode` | opencode CLI コマンドパス |
| `commitPush.autoCommitAfterGenerate` | boolean | `true` | 生成直後に自動コミットする |
| `commitPush.pushRemote` | string | `origin` | 自動pushのremote名 |
| `commitPush.pushBranch` | string | `main` | 自動push対象ブランチ名 |

## Usage

1. Source Controlビューで `commitMessage生成` を押す  
2. SCM入力欄に生成メッセージが入る  
3. 既定では自動コミットされる（`autoCommitAfterGenerate=true`）  
4. 最新コミット1行目が生成文面と一致し、現在ブランチが `pushBranch` と一致すると自動 push
