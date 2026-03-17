# SillyTavern Telegram Bot Service - 架构文档

## 项目概述

这是一个基于 **Clean Architecture（整洁架构）** 设计的 Telegram AI 聊天机器人项目。核心功能是将 SillyTavern 的角色扮演能力通过 Telegram Bot 提供给用户，支持流式对话、多模型切换、对话存档等特性。

---

## 目录结构

```
src/
├── server_tg.ts                    # 入口点
├── platform/                       # 平台基础设施
│   ├── config.ts                   # 配置管理
│   ├── logger.ts                   # 日志系统
│   ├── tracing.ts                  # 链路追踪
│   └── RequestTimer.ts             # 性能计时器
├── core/                           # 核心接口定义
│   └── ports/                      # 端口接口
│       ├── ISTEngine.ts            # AI引擎接口
│       └── SessionStore.ts         # 会话存储接口
├── features/                       # 功能模块（业务层）
│   ├── telegram_adapter/           # Telegram适配器
│   │   ├── TelegramBotAdapter.ts   # Bot消息处理
│   │   └── UIHandler.ts            # UI组件
│   ├── chat/                       # 聊天功能
│   │   ├── usecases/               # 用例层
│   │   │   └── SimpleChat.ts       # 核心聊天逻辑
│   │   ├── domain/                 # 领域模型
│   │   │   └── ModelStrategy.ts    # 模型策略
│   │   ├── ports/                  # 端口接口
│   │   │   ├── IAIChannel.ts       # AI通道接口
│   │   │   └── IMessageRepository.ts
│   │   └── rules/                  # 业务规则
│   │       └── streamingSchedule.ts
│   ├── session/                    # 会话管理
│   │   └── usecases/
│   │       └── SessionManager.ts   # 会话管理器
│   └── credits/                    # 积分系统
│       └── rules/
│           └── creditCost.ts       # 积分计费规则
├── infrastructure/                 # 基础设施层
│   ├── ai/                         # AI通道实现
│   │   ├── ChannelRegistry.ts      # 通道注册表
│   │   └── channels/
│   │       └── PipelineChannel.ts  # 管道通道
│   ├── st_matrix/                  # SillyTavern核心适配
│   │   ├── STEngineAdapter.ts      # ST引擎适配器
│   │   ├── VirtualContext.js       # 虚拟上下文
│   │   └── CoreFactory.cjs         # ST Core (排除)
│   ├── repositories/               # 数据仓储
│   │   ├── SupabaseMessageRepository.ts
│   │   ├── SupabaseUserRepository.ts
│   │   └── SupabaseSnapshotRepository.ts
│   ├── supabase/                   # Supabase客户端
│   │   ├── SupabaseClient.ts
│   │   └── CharacterMapper.ts
│   ├── redis/                      # Redis会话存储
│   │   └── UpstashSessionStore.ts
│   ├── runtime_config/             # 运行时配置
│   │   └── RuntimeConfigService.ts
│   └── networking/                 # 网络拦截
│       └── FetchInterceptor.ts
├── types/                          # 类型定义
│   └── config.ts
├── payment-bot/                    # 支付模块 (独立项目)
└── tokenizers/                     # 分词器 (排除)
```

---

## 架构分层详解

### Layer 1: Interface Adapters（接口适配层）

**核心文件**: `features/telegram_adapter/TelegramBotAdapter.ts`

**职责**：
- 监听 Telegram 消息事件
- 路由指令（`/start`, `/help` 等）
- 处理菜单交互（设置、角色选择、历史聊天）
- 管理用户状态机（如快照命名）
- 并发锁机制（防止同一用户并发消息）
- 调用 UseCase 层并发送回复

**关键方法**：
| 方法 | 说明 |
|------|------|
| `_handleMessage()` | 消息入口，包含去重、路由、并发控制 |
| `_handleCommand()` | 指令路由器 |
| `_handleCallbackQuery()` | 按钮回调处理 |
| `_handleSettings()` | 设置面板 |
| `_handleRoleSelection()` | 角色切换 |

---

### Layer 2: Use Cases（用例层）

**核心文件**: 
- `features/chat/usecases/SimpleChat.ts`
- `features/session/usecases/SessionManager.ts`

#### SimpleChat

**职责**：
- 协调 SessionManager 获取/创建会话
- 增强 Prompt（注入系统指令）
- 委托 Channel 执行 AI 生成
- 更新历史记录
- 积分检查与扣除
- 消息持久化（Fire-and-Forget）

**关键方法**：
| 方法 | 说明 |
|------|------|
| `streamChat()` | 流式对话入口 |
| `streamRegenerate()` | 重新生成回复 |
| `_executeStreamGeneration()` | 通用流式生成逻辑 |
| `_enhancePrompt()` | Prompt 增强 |

#### SessionManager

**职责**：
- 会话生命周期管理（创建、获取、过期）
- 角色切换
- 历史记录管理（追加、回滚、重置）
- 快照管理（保存、恢复、删除）
- 用户模型偏好存储

**关键方法**：
| 方法 | 说明 |
|------|------|
| `getOrCreateSession()` | 获取或创建会话 |
| `switchCharacter()` | 切换角色 |
| `appendMessages()` | 追加消息到历史 |
| `rollbackHistoryToLastUser()` | 回滚到最后一条用户消息 |
| `createSnapshot()` / `restoreSnapshot()` | 快照管理 |

---

### Layer 3: Domain（领域层）

**核心文件**:
- `features/chat/domain/ModelStrategy.ts`
- `features/credits/rules/creditCost.ts`
- `features/chat/rules/streamingSchedule.ts`

**职责**：
- 模型层级策略（Tier 1-4 对应不同模型质量/价格）
- 积分计费规则
- 流式上屏调度算法

**模型层级**：
| Tier | 名称 | 说明 |
|------|------|------|
| tier_1 | 快餐模型 | 低成本、快速响应 |
| tier_2 | 基础模型 | 平衡性能与成本 |
| tier_3 | 旗舰模型 | 高质量（默认） |
| tier_4 | 尊享模型 | 最高质量 |

---

### Layer 4: Infrastructure（基础设施层）

#### 4.1 AI 引擎 - STEngineAdapter

**文件**: `infrastructure/st_matrix/STEngineAdapter.ts`

**职责**：
- 封装 SillyTavern Core 引擎
- 提供虚拟 DOM/Window 环境
- 处理 Prompt 组装（System Prompt + History + User Input）
- 支持流式生成

**核心接口**：
```typescript
interface ISTEngine {
    initialize(): Promise<void>;
    loadContext(contextData: STContextData): Promise<void>;
    setConfiguration(config: Record<string, any>): Promise<void>;
    generate(prompt: string, trace?: any): Promise<any>;
    generateStream(prompt: string, trace?: any): AsyncIterable<string>;
}
```

#### 4.2 AI 通道 - PipelineChannel

**文件**: `infrastructure/ai/channels/PipelineChannel.ts`

**职责**：
- 多步骤 AI 请求管道（支持 N 个备选模型）
- 三阶段超时管理：
  - **TTFT (Time To First Token)**: 首 Token 超时 → 切换下一步骤
  - **Inter-chunk**: 中间块超时 → 截断成功
  - **Total**: 总超时 → 截断成功
- 自动重试与降级

#### 4.3 数据存储

| 模块 | 职责 |
|------|------|
| `SupabaseMessageRepository` | 消息持久化（异步，不阻塞响应） |
| `SupabaseUserRepository` | 用户信息管理 |
| `SupabaseSnapshotRepository` | 对话存档管理 |
| `UpstashSessionStore` | Redis 会话存储（历史、元数据） |

#### 4.4 运行时配置 - RuntimeConfigService

**文件**: `infrastructure/runtime_config/RuntimeConfigService.ts`

**三层降级策略**：
1. **Redis** (~10ms) - 60s TTL 缓存
2. **Supabase** (~100-500ms) - Source of Truth
3. **静态配置** (config.ts) - 最终兜底

**支持的配置项**：
- `ai_config_source` - AI 通道配置
- `max_history_items` - 最大历史条数
- `session_timeout_minutes` - 会话过期时间
- `default_role_id` - 默认角色
- `system_instructions` - 系统指令
- `welcome_message` - 欢迎语
- `insufficient_credits_message` - 积分不足提示

---

## 核心数据流

```
┌─────────────────┐
│  Telegram User  │
└────────┬────────┘
         │ 消息
         ▼
┌─────────────────────────────┐
│  TelegramBotAdapter (L1)    │  ← 消息监听 / 指令路由
│  - _handleMessage()         │
│  - _handleCommand()         │
│  - _handleCallbackQuery()   │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  SimpleChat (L2 UseCase)    │  ← 业务编排
│  - streamChat()             │
│  - streamRegenerate()       │
└────────┬────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────────┐
│Session │ │ChannelRegistry│
│Manager │ │ → Pipeline    │
└────────┘ └──────┬───────┘
                  │
                  ▼
┌─────────────────────────────┐
│  STEngineAdapter (L4)       │  ← 虚拟 ST Core
│  - loadContext()            │
│  - generateStream()         │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  FetchInterceptor           │  ← 网络拦截 / LLM 请求
│  → OpenAI / OpenRouter      │
└─────────────────────────────┘
```

---

## 关键设计模式

### 1. 依赖注入（DI）
通过接口（`ISTEngine`, `IAIChannel`, `IMessageRepository`）解耦各层，便于测试和替换实现。

### 2. 端口-适配器模式（Hexagonal Architecture）
- `ports/` 目录定义接口
- `infrastructure/` 实现具体适配器
- 业务逻辑不依赖具体实现

### 3. 管道模式（Pipeline）
`PipelineChannel` 支持多步骤配置，自动重试降级：
```
Step 1 (Grok) → 超时 → Step 2 (DeepSeek) → 超时 → Step 3 (Gemini)
```

### 4. 单例模式
- `RuntimeConfigService` - 全局配置中心
- `SessionManager` - 会话管理器

### 5. 异步流（AsyncGenerator）
流式响应实现，支持实时上屏：
```typescript
async *streamChat(): AsyncGenerator<{ text: string; isFirst: boolean; isFinal: boolean }>
```

### 6. Fire-and-Forget 模式
非关键路径异步执行，不阻塞用户响应：
- 消息持久化
- 积分扣除
- OpenRouter 统计回填

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js / TypeScript / TSX |
| Telegram | node-telegram-bot-api |
| 数据库 | Supabase (PostgreSQL) |
| 缓存 | Upstash Redis (REST API) |
| 日志 | Winston + DailyRotateFile |
| AI 后端 | OpenAI / OpenRouter / SiliconFlow |
| 核心引擎 | SillyTavern Core (虚拟化) |

---

## 启动方式

```bash
# 开发模式
npm run start
# 或
tsx src/server_tg.ts
```

---

## 环境变量

关键环境变量（详见 `.env`）：

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_PROXY_*` | 代理配置（可选） |
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_API_URL` | OpenAI 兼容接口地址 |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase 配置 |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | Redis 配置 |
| `DEFAULT_ROLE_ID` | 默认角色 ID |
| `LOG_LEVEL` | 日志级别 (debug/info/warn/error) |

---

## 日志系统

**日志分类标签 (kind)**：
- `biz` - 业务日志（Usecase 层）- 用于还原用户行为
- `sys` - 系统日志（Adapter 层）- 用于定位 Bug
- `infra` - 基础设施日志（Infrastructure 层）- 用于监控资源

**日志文件**：
- `logs/app-YYYY-MM-DD.log` - 主日志（保留 14 天）
- `logs/internal-YYYY-MM-DD.log` - ST 内部日志（保留 3 天）

---

## 排除目录

以下目录不属于本项目核心源码：
- `infrastructure/st_matrix/CoreFactory.cjs` - SillyTavern 打包产物
- `payment-bot/` - 独立的支付机器人项目
- `tokenizers/` - 分词器资源

---

*文档生成时间：2026-03-05*
