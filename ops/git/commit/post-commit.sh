#!/usr/bin/env bash
set -euo pipefail

# 加载配置
SCRIPT_DIR="$(dirname "$(realpath "$0")")"
source "$SCRIPT_DIR/../config.sh"

COMMIT_ID="$(git rev-parse HEAD)"

# 直接读取已经生成的commit消息，避免重复AI调用
COMMIT_MESSAGE="$(cat "$PROJECT_ROOT/.git/COMMIT_EDITMSG")"

# 构建快照JSON（复用commit-msg阶段的AI生成结果）
COMMIT_LOG=$(jq -n \
  --arg commit_id "$COMMIT_ID" \
  --arg author "$(git config user.name) <$(git config user.email)>" \
  --arg date "$(date -Iseconds)" \
  --arg message "$COMMIT_MESSAGE" \
  '{
    commit_id: $commit_id,
    author: $author,
    date: $date,
    message: $message
  }')

# 保存快照（文件名 = 时间戳.json）
mkdir -p "$SNAPSHOTS_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
echo "$COMMIT_LOG" > "$SNAPSHOTS_DIR/$TIMESTAMP.json"

echo "Commit log saved: $SNAPSHOTS_DIR/$TIMESTAMP.json"
