# Git 运维工具

这是一套完整的 Git 版本管理和 AI 总结运维工具，支持自动生成 commit 消息和 push 日志。

## 功能特性

- 🤖 **AI 自动生成 commit 消息**：基于代码差异自动生成规范的提交信息
- 📊 **智能 push 日志**：生成面向工程和产品的双重总结
- 🔄 **自动快照管理**：commit 时保存快照，push 时整理归档
- ⚙️ **TypeScript 实现**：与项目技术栈保持一致

## 快速开始

### 安装 Git Hooks

```bash
bash ops/git/install_hooks.sh
```

### 依赖要求

- Node.js 18+
- tsx (已在 devDependencies 中，比 ts-node 更好的 ESM 支持)
- jq 命令行工具（用于 JSON 处理）

## 配置说明

### config.sh 配置文件

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `PROJECT_ROOT` | 项目根路径 | 自动检测 |
| `TS_NODE_CMD` | TypeScript 执行方式 | `npx tsx` |
| `PROMPT_DIR` | Prompt 文件目录 | `${PROJECT_ROOT}/ops/gpt/prompt` |
| `LOGS_DIR` | 日志存储目录 | `${PROJECT_ROOT}/ops/git/logs` |

### 环境变量

在项目根目录 `.env` 文件中配置：

```bash
OPENAI_API_KEY=your-api-key
OPENAI_API_URL=https://api.openai.com/v1/chat/completions
OPS_GPT_MODEL=gpt-4.1  # 可选，默认 gpt-4.1
```

## 目录结构

```
ops/
├── git/
│   ├── config.sh              # 配置文件
│   ├── install_hooks.sh       # 安装脚本
│   ├── README.md              # 本文件
│   ├── commit/
│   │   ├── gen_commit_msg.ts  # AI 生成 commit 消息
│   │   ├── commit_msg.sh      # commit-msg hook 逻辑
│   │   └── post-commit.sh     # post-commit hook 逻辑
│   ├── push/
│   │   ├── gen_pushlog.ts     # AI 生成 push 日志
│   │   └── pre-push-hook.sh   # pre-push hook 逻辑
│   └── logs/
│       ├── snapshots/         # commit 快照存储
│       └── pushlogs/          # push 日志存储
└── gpt/
    ├── gptCaller.ts           # GPT API 调用封装
    ├── promptLoader.ts        # Prompt 模板加载
    └── prompt/
        ├── commit_process_diff.prompt
        ├── push_log_title.prompt
        ├── push_log_arch2pr.prompt
        └── solid_save/        # 项目上下文配置
            ├── long/          # 长期不变的配置
            │   ├── arch.txt
            │   ├── principle.txt
            │   └── project_business_goal.txt
            └── mid/           # 阶段性配置
                ├── requirements_functional_spec.txt
                └── workstream/
                    └── current_mission.txt
```

## 工作流程

1. **Commit 阶段**：
   - `commit-msg` hook 调用 AI 生成 commit 消息
   - `post-commit` hook 保存 commit 快照到 `snapshots/`

2. **Push 阶段**：
   - `pre-push` hook 调用 AI 生成 push 总结
   - 自动将 `snapshots/` 中的快照归档到对应的 push 日志目录

## 自定义项目上下文

编辑 `ops/gpt/prompt/solid_save/` 目录下的文件来配置项目上下文：

- `long/arch.txt` - 项目架构说明
- `long/principle.txt` - 开发原则与方法论
- `long/project_business_goal.txt` - 业务目标
- `mid/requirements_functional_spec.txt` - 功能规格说明
- `mid/workstream/current_mission.txt` - 当前任务

## 故障排查

### 常见问题

1. **TypeScript 执行失败**
   - 检查 `tsx` 是否安装: `npm ls tsx`
   - 测试运行: `npx tsx -e "console.log('OK')"`

2. **GPT 调用失败**
   - 检查 `.env` 中的 `OPENAI_API_KEY`
   - 检查网络连接和代理设置

3. **Prompt 文件读取失败**
   - 检查 `PROMPT_DIR` 路径配置
   - 确保所需的 prompt 文件存在

### 测试配置

```bash
# 测试配置是否正确
source ops/git/config.sh
echo "项目根路径: $PROJECT_ROOT"
echo "TypeScript: $TS_NODE_CMD"
echo "Prompt目录: $PROMPT_DIR"

# 测试 TypeScript 执行
npx tsx -e "console.log('TypeScript OK')"

# 测试 GPT 模块
npx tsx ops/git/commit/gen_commit_msg.ts --diff /dev/null
```
