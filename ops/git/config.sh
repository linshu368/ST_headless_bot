#!/bin/bash
# Git运维工具配置文件
# 🔧 新项目迁移时需要检查的配置：
# 1. TS_NODE_CMD - TypeScript 执行方式
# 2. PROMPT_DIR - prompt文件目录
# 其他配置通常不需要修改

# 项目根路径（通常不需要改）
PROJECT_ROOT="$(git rev-parse --show-toplevel)"

# TypeScript 执行命令（根据项目调整）
# 使用 tsx 运行 (比 ts-node 更好的 ESM 支持)
TS_NODE_CMD="npx tsx"

# Prompt文件目录（根据项目调整）
PROMPT_DIR="${PROJECT_ROOT}/ops/gpt/prompt"

# 日志目录（通常不需要改）
LOGS_DIR="${PROJECT_ROOT}/ops/git/logs"
SNAPSHOTS_DIR="${LOGS_DIR}/snapshots"
PUSHLOGS_DIR="${LOGS_DIR}/pushlogs"

# 导出环境变量供 TypeScript 脚本使用
export PROMPT_DIR
export LOGS_DIR
