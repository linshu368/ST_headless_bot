#!/usr/bin/env bash
set -euo pipefail

# 加载配置
SCRIPT_DIR="$(dirname "$(realpath "$0")")"
source "$SCRIPT_DIR/config.sh"

HOOK_DIR="$PROJECT_ROOT/.git/hooks"

mkdir -p "$HOOK_DIR"

echo "🔧 Git运维工具安装中..."
echo "项目根路径: $PROJECT_ROOT"
echo "TypeScript执行: $TS_NODE_CMD"
echo "Prompt目录: $PROMPT_DIR"
echo "日志目录: $LOGS_DIR"
echo ""

#############################################
# commit-msg hook
#############################################
cat > "$HOOK_DIR/commit-msg" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

COMMIT_MSG_FILE="$1"
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
bash "$PROJECT_ROOT/ops/git/commit/commit_msg.sh" "$COMMIT_MSG_FILE"
EOF

chmod +x "$HOOK_DIR/commit-msg"
echo "✅ commit-msg hook 已安装"


#############################################
# pre-push hook
#############################################
cat > "$HOOK_DIR/pre-push" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REMOTE="$1"
URL="$2"

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
bash "$PROJECT_ROOT/ops/git/push/pre-push-hook.sh" "$@"
EOF

chmod +x "$HOOK_DIR/pre-push"
echo "✅ pre-push hook 已安装"


#############################################
# post-commit hook
#############################################
cat > "$HOOK_DIR/post-commit" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
bash "$PROJECT_ROOT/ops/git/commit/post-commit.sh"
EOF

chmod +x "$HOOK_DIR/post-commit"
echo "✅ post-commit hook 已安装"

echo ""
echo "🎉 Git运维工具安装完成！"
echo ""
echo "📝 新项目迁移说明："
echo "1. 复制整个 ops/ 目录到新项目"
echo "2. 修改 ops/git/config.sh 中的路径配置"
echo "3. 运行 bash ops/git/install_hooks.sh"
echo ""
echo "⚙️  当前配置："
echo "- TypeScript: $TS_NODE_CMD"
echo "- Prompt目录: $PROMPT_DIR"
echo "- 日志目录: $LOGS_DIR"
