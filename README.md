# Simple Agent SDK

基于 OpenAI 的轻量级多轮 Agent SDK，支持工具调用（Tool Calling）和 MCP（Model Context Protocol）集成。

## 安装

```bash
pnpm install
```

需要 Node.js >= 22。

## 配置

复制 `.env.example` 为 `.env` 并填入你的 API 信息：

```bash
cp .env.example .env
```

```env
# 必填：API Key
OPENAI_API_KEY=your-api-key

# 可选：自定义 API 地址（兼容 OpenAI 格式的第三方服务，如智谱、DeepSeek 等）
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# 可选：模型名称（默认 gpt-4o-mini）
MODEL=GLM-5.1
```

SDK 会自动加载 `.env` 文件。也可以通过环境变量或代码中传入 `apiKey` / `baseURL` 覆盖：

```typescript
const config = {
  model: "GLM-5.1",
  systemPrompt: "...",
  tools: [myTool],
  apiKey: "your-key",                   // 覆盖 .env 中的值
  baseURL: "https://your-proxy/v1",     // 覆盖 .env 中的值
}
```

## 快速开始

```typescript
import { createSession, streamAgent, type Tool } from "simple-agent"

// 1. 定义工具
const getWeatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather for a given city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
  execute: async (args) => {
    const { city } = args as { city: string }
    return { output: JSON.stringify({ city, temp: 22, condition: "sunny" }) }
  },
}

// 2. 创建会话
const session = createSession({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant.",
  tools: [getWeatherTool],
})

// 3. 添加用户消息
session.messages.push({
  id: "user-1",
  role: "user",
  content: [{ type: "text", text: "What's the weather in Tokyo?" }],
  createdAt: new Date(),
})

// 4. 流式获取 Agent 响应
const config = {
  model: "gpt-4o-mini",
  systemPrompt: session.systemPrompt,
  tools: [getWeatherTool],
  // apiKey: "sk-xxx",               // 可选，不传则从 OPENAI_API_KEY 环境变量读取
  // baseURL: "https://your-proxy/v1", // 可选，不传则从 OPENAI_BASE_URL 环境变量读取
}

for await (const event of streamAgent(session, config)) {
  if (event.type === "text") process.stdout.write(event.text)
  if (event.type === "tool_call") console.log(`[Calling ${event.name}]`)
  if (event.type === "tool_result") console.log(`[Result: ${event.result}]`)
}
```

## 核心概念

### Agent 工作流程

```
用户消息 → LLM 生成响应 → 检测到工具调用? → 执行工具 → 结果返回 LLM → 循环
                              ↓ 无工具调用
                           返回最终响应
```

Agent 会持续循环，直到 LLM 不再请求工具调用，或达到最大步数限制（默认 200）。

### 流式事件 (AgentEvent)

在 `streamAgent` 迭代过程中，你会收到以下事件：

| 事件 | 说明 |
|------|------|
| `message_start` | LLM 开始新一轮响应 |
| `text` | 文本增量输出（逐 token） |
| `tool_call` | LLM 请求调用某个工具 |
| `tool_result` | 工具执行完毕，返回结果 |
| `message_end` | LLM 本轮响应结束 |
| `error` | 发生错误 |

## 自定义工具

实现 `Tool` 接口即可创建自定义工具：

```typescript
import { type Tool } from "simple-agent"

const myTool: Tool = {
  name: "search_database",
  description: "Search database for records",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "SQL query" },
      limit: { type: "number", description: "Max results" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, limit = 10 } = args as { query: string; limit?: number }
    const results = await db.query(query, limit)
    return { output: JSON.stringify(results) }
  },
}
```

`execute` 函数接收 LLM 传入的参数，返回 `ToolResult`：

```typescript
interface ToolResult {
  output: string           // 工具输出
  metadata?: Record<string, unknown>  // 可选元数据
  error?: string           // 设置此字段表示执行出错
}
```

## 多轮对话

复用同一个 `session` 即可保持上下文：

```typescript
async function chat(userInput: string) {
  session.messages.push({
    id: `user-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: userInput }],
    createdAt: new Date(),
  })

  for await (const event of streamAgent(session, config)) {
    if (event.type === "text") process.stdout.write(event.text)
  }
  console.log()
}

await chat("What is 123 * 456?")
await chat("Reverse the result as a string")   // Agent 记得上一轮的上下文
```

## MCP 集成

通过 MCP 从外部服务器动态加载工具。

### stdio 模式（本地进程）

```typescript
import { loadMCPTools } from "simple-agent"

const { tools, client } = await loadMCPTools({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  name: "filesystem-mcp",
})

console.log("MCP tools:", tools.map(t => t.name))
// → ["read_file", "write_file", "list_directory", "search_files", ...]

// 使用完毕后断开连接
await client.disconnect()
```

### HTTP 模式（远程服务器）

```typescript
const { tools, client } = await loadMCPTools({
  transport: "http",
  url: "http://localhost:3000/mcp",
  name: "remote-mcp",
})
```

### 混合使用 MCP 工具和自定义工具

```typescript
const localTools: Tool[] = [myCustomTool]
const { tools: mcpTools, client } = await loadMCPTools({ ... })

const allTools = [...localTools, ...mcpTools]

const session = createSession({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant with file and custom tools.",
  tools: allTools,
})

// ... 使用 session ...

await client.disconnect()  // 清理
```

## API 参考

### `createSession(config)`

创建一个新的 Agent 会话。

```typescript
const session = createSession({
  model: "gpt-4o-mini",       // 模型名称
  systemPrompt: "...",         // 系统提示词
  tools: [tool1, tool2],       // 可用工具列表
  maxTokens: 4096,             // 可选，最大输出 token
  temperature: 0,              // 可选，温度参数
})
```

返回一个 `Session` 对象。

### `streamAgent(session, config)`

流式运行 Agent，返回 `AsyncGenerator<AgentEvent>`。

```typescript
for await (const event of streamAgent(session, {
  model: "gpt-4o-mini",
  systemPrompt: "...",
  tools: [...],
  apiKey: "sk-xxx",             // 可选
  baseURL: "https://...",       // 可选
  maxSteps: 50,                // 可选，最大循环次数（默认 200）
})) {
  // 处理事件
}
```

### `runAgent(session, config)`

非流式运行 Agent，等所有轮次完成后返回消息列表。

```typescript
const messages = await runAgent(session, config)
```

### `loadMCPTools(config)`

连接 MCP 服务器并加载其提供的工具。

```typescript
const { tools, client } = await loadMCPTools({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  name: "my-mcp",              // 可选，客户端名称
})
```

### `withRetry(fn, config?)`

为异步操作添加指数退避重试。

```typescript
import { withRetry } from "simple-agent"

const result = await withRetry(
  () => fetch("https://api.example.com/data"),
  {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    retryableErrors: ["rate_limit", "timeout"],
  },
)
```

### `ToolRegistry` / `ToolExecutor`

底层工具管理组件，可直接使用：

```typescript
import { ToolRegistry, ToolExecutor } from "simple-agent"

const registry = new ToolRegistry()
registry.register(myTool)

const executor = new ToolExecutor(registry)
const result = await executor.execute(
  { type: "tool_call", id: "1", name: "my_tool", arguments: { key: "value" } },
  { sessionId: "s1", messageId: "m1" },
)
```

## 运行示例

配置好 `.env` 后直接运行：

```bash
pnpm example:basic          # 单工具天气查询
pnpm example:custom-tools   # 多工具 + 多轮对话
pnpm example:mcp            # MCP 集成
```

## 项目结构

```
src/
├── types.ts           # 核心类型定义
├── index.ts           # 公共 API 导出
├── agent/loop.ts      # Agent 循环逻辑
├── llm/client.ts      # OpenAI 客户端（流式）
├── tool/
│   ├── registry.ts    # 工具注册表
│   └── executor.ts    # 工具执行器
├── mcp/client.ts      # MCP 客户端
└── util/retry.ts      # 重试机制
```

## 构建

```bash
pnpm build       # 编译到 dist/
pnpm typecheck   # 类型检查
```
