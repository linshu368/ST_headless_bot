#!/usr/bin/env bash
set -euo pipefail

# 加载配置
SCRIPT_DIR="$(dirname "$(realpath "$0")")"
source "$SCRIPT_DIR/../config.sh"

COMMIT_MSG_FILE="${1:?usage: commit-msg .git/COMMIT_EDITMSG}"

# 关闭 npm 更新提示与 dotenv 日志，避免污染 JSON 输出
export NPM_CONFIG_UPDATE_NOTIFIER=false
export DOTENV_CONFIG_QUIET=true

DIFF_FILE="$(mktemp -t diff.XXXXXX.patch)"
git diff --cached > "$DIFF_FILE"

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "chore(core): empty commit" > "$COMMIT_MSG_FILE"
  exit 0
fi

# 调用 TypeScript 脚本，生成 JSON
OUT_JSON="$($TS_NODE_CMD "$PROJECT_ROOT/ops/git/commit/gen_commit_msg.ts" \
  --diff "$DIFF_FILE")"

# 取出 message
raw_message="$(echo "$OUT_JSON" | jq -r '.message')"

# 如果 AI 返回失败提示，也阻止提交
if [[ "$raw_message" == "> AI 生成失败"* ]]; then
  echo "❌ AI 调用异常，提交已被阻止"
  exit 1
fi

# 写入 commit message
echo "$raw_message" > "$COMMIT_MSG_FILE"

echo "AI Commit Message:"
echo "$raw_message"
