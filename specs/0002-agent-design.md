# Simple Agent 实现设计 (v2)

基于 `0001-simple-agent-design.md` 的概念设计，本文档是面向实现的详细设计，基于 OpenAI SDK，与已实现的代码对齐。

## 1. 架构总览

```
┌─────────────────────────── Agent Loop ───────────────────────────┐
│                                                                    │
│  User Input                                                        │
│      │                                                             │
│      ▼                                                             │
│  ┌────────┐     ┌──────────────┐     Y     ┌──────────────┐      │
│  │  LLM   │────►│  Tool Call?  │──────────►│ Execute Tool  │      │
│  │ Client │     └──────────────┘           └──────┬───────┘      │
│  └───▲────┘          │ N                           │              │
│      │               ▼                             ▼              │
│      │        ┌──────────────┐            ┌──────────────┐       │
│      │        │   Result     │◄───────────│  Tool Result  │       │
│      │        │   Response   │◄───────────└──────────────┘       │
│      └────────┴──────────────┘                                    │
│                                                                    │
│  步骤: maxSteps 守卫防止无限循环                                    │
│  中断: AbortSignal 支持取消                                        │
└────────────────────────────────────────────────────────────────────┘
```

**核心流程**:
1. 用户输入 → 添加到 Session 消息历史
2. 调用 LLM（带工具定义）
3. 判断响应中是否包含 tool_calls
4. 如果有 → 执行工具 → 将结果添加到消息历史 → 回到步骤 2
5. 如果没有 → 返回最终响应

## 2. 已实现模块回顾

以下模块已在 `src/` 中实现，新设计直接复用：

| 模块 | 文件 | 状态 |
|------|------|------|
| 类型定义 | `src/types.ts` | ✅ 已完成 |
| 工具注册表 | `src/tool/registry.ts` | ✅ 已完成 |
| 工具执行器 | `src/tool/executor.ts` | ✅ 已完成 |
| 重试工具 | `src/util/retry.ts` | ✅ 已完成 |

## 3. 待实现模块

### 3.1 LLM 客户端 (`src/llm/client.ts`)

封装 OpenAI SDK，提供统一的 LLM 调用接口。

```typescript
import OpenAI from "openai"
import type { Message, MessageContent, ToolDefinition } from "../types.ts"

export interface LLMCallInput {
  model: string
  messages: Message[]
  systemPrompt: string
  tools: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
}

export interface LLMCallOutput {
  content: MessageContent[]
  finishReason: "stop" | "tool_calls" | "max_tokens" | "error"
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export class LLMClient {
  private client: OpenAI

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: options?.baseURL ?? process.env["OPENAI_BASE_URL"],
    })
  }

  async call(input: LLMCallInput): Promise<LLMCallOutput> {
    // 将内部 Message[] 转换为 OpenAI ChatCompletionMessageParam[]
    // 调用 this.client.chat.completions.create()
    // 将 OpenAI 响应转换为 LLMCallOutput
  }
}
```

**关键：OpenAI API 类型映射**

```
内部类型                          OpenAI 类型
─────────────                    ──────────────
Message (role: "user")     →   ChatCompletionUserMessageParam
Message (role: "assistant") →  ChatCompletionAssistantMessageParam
Message (role: "tool")     →   ChatCompletionToolMessageParam
TextContent                →   { type: "text", text: string }
ToolCallContent            →   { type: "function", id, function: { name, arguments } }
ToolResultContent          →   { tool_call_id, content }
ToolDefinition             →   { type: "function", function: { name, description, parameters } }
```

**消息转换逻辑** (`toOpenAIMessages`):

```typescript
function toOpenAIMessages(
  messages: Message[],
  systemPrompt: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ]

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        result.push({
          role: "user",
          content: msg.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
        })
        break

      case "assistant": {
        const textParts = msg.content.filter(
          (c): c is TextContent => c.type === "text",
        )
        const toolParts = msg.content.filter(
          (c): c is ToolCallContent => c.type === "tool_call",
        )

        result.push({
          role: "assistant",
          content: textParts.length > 0 ? textParts.map((t) => t.text).join("\n") : null,
          tool_calls: toolParts.length > 0
            ? toolParts.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments:
                    typeof tc.arguments === "string"
                      ? tc.arguments
                      : JSON.stringify(tc.arguments),
                },
              }))
            : undefined,
        })
        break
      }

      case "tool": {
        // 每个 ToolResultContent 对应一条 tool message
        for (const c of msg.content) {
          if (c.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: c.toolCallId,
              content: c.result,
            })
          }
        }
        break
      }
    }
  }

  return result
}
```

**OpenAI 响应转换** (`fromOpenAIResponse`):

```typescript
function fromOpenAIResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): LLMCallOutput {
  const choice = response.choices[0]
  const content: MessageContent[] = []

  // 提取文本内容
  const text = choice.message.content
  if (text) {
    content.push({ type: "text", text })
  }

  // 提取工具调用
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_call",
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })
    }
  }

  // 映射 finish_reason
  const finishReasonMap: Record<string, LLMCallOutput["finishReason"]> = {
    stop: "stop",
    tool_calls: "tool_calls",
    length: "max_tokens",
  }

  return {
    content,
    finishReason: finishReasonMap[choice.finish_reason ?? "stop"] ?? "stop",
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  }
}
```

**工具定义转换** (`toOpenAITools`):

```typescript
function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
```

### 3.2 流式 LLM (`src/llm/stream.ts`)

基于 OpenAI streaming 的实时输出。

```typescript
export type LLMStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "finish"; reason: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; error: Error }

export async function* streamLLM(
  client: OpenAI,
  input: LLMCallInput,
): AsyncGenerator<LLMStreamEvent> {
  const stream = await client.chat.completions.create(
    {
      model: input.model,
      messages: toOpenAIMessages(input.messages, input.systemPrompt),
      tools: input.tools.length > 0 ? toOpenAITools(input.tools) : undefined,
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: input.abortSignal },
  )

  // 累积 tool call 的 arguments（streaming 时分段到达）
  const toolCallBuffers = new Map<string, { name: string; args: string }>()

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (!delta) continue

    // 文本增量
    if (delta.content) {
      yield { type: "text_delta", text: delta.content }
    }

    // 工具调用增量
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.id && tc.function?.name) {
          // tool_call_start
          toolCallBuffers.set(tc.id, { name: tc.function.name, args: "" })
          yield { type: "tool_call_start", id: tc.id, name: tc.function.name }
        }
        if (tc.function?.arguments && tc.id) {
          // tool_call_delta
          const buf = toolCallBuffers.get(tc.id)
          if (buf) buf.args += tc.function.arguments
          yield { type: "tool_call_delta", id: tc.id, arguments: tc.function.arguments }
        }
      }
    }

    // usage 信息（在最后一个 chunk）
    if (chunk.usage) {
      const finishReason = chunk.choices[0]?.finish_reason ?? "stop"
      // 结束所有未关闭的 tool calls
      for (const id of toolCallBuffers.keys()) {
        yield { type: "tool_call_end", id }
      }
      yield {
        type: "finish",
        reason: finishReason,
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
      }
    }
  }
}
```

### 3.3 会话管理 (`src/session/session.ts`)

管理对话历史和状态。

```typescript
import { v4 as uuid } from "uuid"
import type { Message, MessageContent, ModelConfig, Session } from "../types.ts"
import { ToolRegistry } from "../tool/registry.ts"

export class SessionManager {
  createSession(options: {
    systemPrompt?: string
    model?: ModelConfig
    tools?: Tool[]
  }): Session {
    const registry = new ToolRegistry()
    for (const tool of options.tools ?? []) {
      registry.register(tool)
    }

    return {
      id: uuid(),
      messages: [],
      systemPrompt: options.systemPrompt ?? "You are a helpful assistant.",
      model: options.model ?? { name: "gpt-4o" },
      tools: options.tools ?? [],
      status: "idle",
    }
  }

  addUserMessage(session: Session, text: string): Message {
    const message: Message = {
      id: uuid(),
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date(),
    }
    session.messages.push(message)
    return message
  }

  addAssistantMessage(session: Session, content: MessageContent[]): Message {
    const message: Message = {
      id: uuid(),
      role: "assistant",
      content,
      createdAt: new Date(),
    }
    session.messages.push(message)
    return message
  }

  addToolResults(session: Session, results: MessageContent[]): Message {
    const message: Message = {
      id: uuid(),
      role: "tool",
      content: results,
      createdAt: new Date(),
    }
    session.messages.push(message)
    return message
  }
}
```

### 3.4 Agent 循环 (`src/agent/loop.ts`)

核心 Agent Loop 实现，这是整个系统的心脏。

```typescript
import { v4 as uuid } from "uuid"
import type {
  Message,
  MessageContent,
  Session,
  ToolCallContent,
  ToolResultContent,
  ExecutionContext,
} from "../types.ts"
import { LLMClient } from "../llm/client.ts"
import type { LLMCallOutput } from "../llm/client.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { ToolExecutor } from "../tool/executor.ts"
import { withRetry } from "../util/retry.ts"

export interface AgentConfig {
  model?: string
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  onStep?: (step: AgentStep) => void
}

export type AgentStep =
  | { type: "llm_start"; step: number }
  | { type: "llm_response"; content: MessageContent[]; finishReason: string }
  | { type: "tool_start"; calls: ToolCallContent[] }
  | { type: "tool_result"; results: ToolResultContent[] }
  | { type: "done"; steps: number; totalUsage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; error: Error; step: number }

export interface AgentResult {
  messages: Message[]
  steps: number
  totalUsage: { inputTokens: number; outputTokens: number }
  finalContent: MessageContent[]
}

export async function runAgent(
  session: Session,
  registry: ToolRegistry,
  config: AgentConfig = {},
): Promise<AgentResult> {
  const llm = new LLMClient()
  const executor = new ToolExecutor(registry)
  const maxSteps = config.maxSteps ?? 50
  let totalUsage = { inputTokens: 0, outputTokens: 0 }
  session.status = "running"

  try {
    for (let step = 0; step < maxSteps; step++) {
      config.onStep?.({ type: "llm_start", step })

      // 1. 调用 LLM
      const response: LLMCallOutput = await withRetry(
        () =>
          llm.call({
            model: config.model ?? session.model.name,
            messages: session.messages,
            systemPrompt: config.systemPrompt ?? session.systemPrompt,
            tools: registry.toToolDefinitions(),
            maxTokens: config.maxTokens ?? session.model.maxTokens,
            temperature: config.temperature ?? session.model.temperature,
            abortSignal: config.abortSignal,
          }),
        { retryableErrors: ["rate_limit", "timeout", "connection"] },
      )

      totalUsage.inputTokens += response.usage.inputTokens
      totalUsage.outputTokens += response.usage.outputTokens

      config.onStep?.({
        type: "llm_response",
        content: response.content,
        finishReason: response.finishReason,
      })

      // 2. 保存助手消息
      const assistantMessage: Message = {
        id: uuid(),
        role: "assistant",
        content: response.content,
        createdAt: new Date(),
      }
      session.messages.push(assistantMessage)

      // 3. 提取工具调用
      const toolCalls = response.content.filter(
        (c): c is ToolCallContent => c.type === "tool_call",
      )

      // 4. 没有工具调用 → 循环结束
      if (toolCalls.length === 0) {
        config.onStep?.({ type: "done", steps: step + 1, totalUsage })
        break
      }

      // 5. 并行执行所有工具
      config.onStep?.({ type: "tool_start", calls: toolCalls })
      const ctx: ExecutionContext = {
        sessionId: session.id,
        messageId: assistantMessage.id,
        abortSignal: config.abortSignal,
      }
      const results = await executor.executeAll(toolCalls, ctx)

      config.onStep?.({ type: "tool_result", results })

      // 6. 将工具结果添加到消息历史
      const toolMessage: Message = {
        id: uuid(),
        role: "tool",
        content: results,
        createdAt: new Date(),
      }
      session.messages.push(toolMessage)

      // 7. 继续循环
    }

    session.status = "completed"

    // 提取最终内容（最后一条 assistant 消息）
    const lastAssistant = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant")

    return {
      messages: session.messages,
      steps: session.messages.filter((m) => m.role === "assistant").length,
      totalUsage,
      finalContent: lastAssistant?.content ?? [],
    }
  } catch (error) {
    session.status = "error"
    config.onStep?.({
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      step: session.messages.filter((m) => m.role === "assistant").length,
    })
    throw error
  }
}
```

### 3.5 流式 Agent 循环 (`src/agent/stream.ts`)

支持实时输出的流式 Agent。

```typescript
import { v4 as uuid } from "uuid"
import type {
  Message,
  MessageContent,
  Session,
  ToolCallContent,
  ToolResultContent,
  ExecutionContext,
} from "../types.ts"
import { LLMClient } from "../llm/client.ts"
import { streamLLM } from "../llm/stream.ts"
import type { LLMStreamEvent } from "../llm/stream.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { ToolExecutor } from "../tool/executor.ts"

export type StreamAgentEvent =
  | { type: "step_start"; step: number }
  | { type: "text"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; results: ToolResultContent[] }
  | { type: "step_end"; step: number }
  | { type: "done"; steps: number }
  | { type: "error"; error: Error }

export async function* streamAgent(
  session: Session,
  registry: ToolRegistry,
  config: {
    model?: string
    systemPrompt?: string
    maxSteps?: number
    maxTokens?: number
    temperature?: number
    abortSignal?: AbortSignal
  } = {},
): AsyncGenerator<StreamAgentEvent> {
  const llm = new LLMClient()
  const executor = new ToolExecutor(registry)
  const maxSteps = config.maxSteps ?? 50

  session.status = "running"

  try {
    for (let step = 0; step < maxSteps; step++) {
      yield { type: "step_start", step }

      const content: MessageContent[] = []
      const toolCallsAccum: Map<string, { name: string; args: string }> = new Map()
      let fullText = ""

      // 流式接收 LLM 响应
      for await (const event of streamLLM(llm["client"], {
        model: config.model ?? session.model.name,
        messages: session.messages,
        systemPrompt: config.systemPrompt ?? session.systemPrompt,
        tools: registry.toToolDefinitions(),
        maxTokens: config.maxTokens ?? session.model.maxTokens,
        temperature: config.temperature ?? session.model.temperature,
        abortSignal: config.abortSignal,
      })) {
        switch (event.type) {
          case "text_delta":
            fullText += event.text
            yield { type: "text", text: event.text }
            break

          case "tool_call_start":
            toolCallsAccum.set(event.id, { name: event.name, args: "" })
            yield { type: "tool_call_start", id: event.id, name: event.name }
            break

          case "tool_call_delta": {
            const buf = toolCallsAccum.get(event.id)
            if (buf) buf.args += event.arguments
            yield { type: "tool_call_delta", id: event.id, arguments: event.arguments }
            break
          }

          case "tool_call_end": {
            const buf = toolCallsAccum.get(event.id)
            if (buf) {
              yield {
                type: "tool_call_end",
                id: event.id,
                name: buf.name,
                arguments: JSON.parse(buf.args),
              }
            }
            break
          }

          case "finish":
            // 流结束
            break
        }
      }

      // 构建完整内容
      if (fullText) {
        content.push({ type: "text", text: fullText })
      }
      const toolCalls: ToolCallContent[] = []
      for (const [id, buf] of toolCallsAccum) {
        const tc: ToolCallContent = {
          type: "tool_call",
          id,
          name: buf.name,
          arguments: JSON.parse(buf.args),
        }
        content.push(tc)
        toolCalls.push(tc)
      }

      // 保存助手消息
      const assistantMessage: Message = {
        id: uuid(),
        role: "assistant",
        content,
        createdAt: new Date(),
      }
      session.messages.push(assistantMessage)

      // 没有工具调用 → 结束
      if (toolCalls.length === 0) {
        yield { type: "step_end", step }
        yield { type: "done", steps: step + 1 }
        break
      }

      // 执行工具
      const ctx: ExecutionContext = {
        sessionId: session.id,
        messageId: assistantMessage.id,
        abortSignal: config.abortSignal,
      }
      const results = await executor.executeAll(toolCalls, ctx)
      yield { type: "tool_result", results }

      // 保存工具结果
      session.messages.push({
        id: uuid(),
        role: "tool",
        content: results,
        createdAt: new Date(),
      })

      yield { type: "step_end", step }
    }

    session.status = "completed"
  } catch (error) {
    session.status = "error"
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}
```

### 3.6 Agent 入口 (`src/agent/agent.ts`)

面向用户的 Agent 类，封装所有模块。

```typescript
import type { Tool, ModelConfig, Session } from "../types.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { SessionManager } from "../session/session.ts"
import { runAgent, type AgentConfig, type AgentResult, type AgentStep } from "./loop.ts"
import { streamAgent, type StreamAgentEvent } from "./stream.ts"

export interface CreateAgentOptions {
  model?: string
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  tools?: Tool[]
}

export class Agent {
  private registry: ToolRegistry
  private sessionManager: SessionManager
  private session: Session
  private config: Omit<CreateAgentOptions, "tools">

  constructor(options: CreateAgentOptions = {}) {
    this.registry = new ToolRegistry()
    this.sessionManager = new SessionManager()
    this.config = options

    // 注册工具
    for (const tool of options.tools ?? []) {
      this.registry.register(tool)
    }

    // 创建会话
    this.session = this.sessionManager.createSession({
      systemPrompt: options.systemPrompt,
      model: { name: options.model ?? "gpt-4o" },
      tools: options.tools,
    })
  }

  /** 注册新工具 */
  use(tool: Tool): this {
    this.registry.register(tool)
    return this
  }

  /** 发送消息并获取完整响应 */
  async chat(
    input: string,
    options?: { onStep?: (step: AgentStep) => void; signal?: AbortSignal },
  ): Promise<AgentResult> {
    this.sessionManager.addUserMessage(this.session, input)
    return runAgent(this.session, this.registry, {
      ...this.config,
      onStep: options?.onStep,
      abortSignal: options?.signal,
    })
  }

  /** 发送消息并流式获取响应 */
  async *stream(
    input: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamAgentEvent> {
    this.sessionManager.addUserMessage(this.session, input)
    yield* streamAgent(this.session, this.registry, {
      ...this.config,
      abortSignal: options?.signal,
    })
  }

  /** 获取当前会话 */
  getSession(): Session {
    return this.session
  }

  /** 重置会话（保留工具和配置） */
  reset(): void {
    this.session = this.sessionManager.createSession({
      systemPrompt: this.config.systemPrompt,
      model: { name: this.config.model ?? "gpt-4o" },
    })
  }
}
```

### 3.7 MCP 集成 (`src/mcp/`)

#### 3.7.1 MCP 客户端 (`src/mcp/client.ts`)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Tool } from "../types.ts"

export interface MCPStdioConfig {
  transport: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type MCPConfig = MCPStdioConfig

export class MCPClient {
  private client: Client
  private transport?: StdioClientTransport

  constructor(private name: string) {
    this.client = new Client({ name: this.name, version: "1.0.0" })
  }

  async connect(config: MCPConfig): Promise<void> {
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env as Record<string, string> | undefined,
    })
    await this.client.connect(this.transport)
  }

  async disconnect(): Promise<void> {
    await this.client.close()
    await this.transport?.close()
  }

  /** 获取 MCP 服务器提供的工具列表 */
  async listTools(): Promise<Tool[]> {
    const result = await this.client.listTools()
    return result.tools.map((t) => adaptMCPTool(this, t))
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args as Record<string, unknown> })
    // MCP 返回 content 数组，提取文本
    return result.content
      .map((c) => {
        if (c.type === "text") return c.text
        return JSON.stringify(c)
      })
      .join("\n")
  }
}
```

#### 3.7.2 MCP 工具适配器 (`src/mcp/adapter.ts`)

将 MCP 工具转换为本地 `Tool` 接口。

```typescript
import type { Tool, JSONSchema } from "../types.ts"
import type { MCPClient } from "./client.ts"

interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: JSONSchema
}

export function adaptMCPTool(client: MCPClient, mcpTool: MCPToolDefinition): Tool {
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: mcpTool.inputSchema,
    execute: async (args: unknown) => {
      const output = await client.callTool(mcpTool.name, args)
      return { output }
    },
  }
}
```

### 3.8 包入口 (`src/index.ts`)

```typescript
// 类型导出
export type {
  TextContent,
  ToolCallContent,
  ToolResultContent,
  MessageContent,
  Message,
  ToolResult,
  JSONSchema,
  Tool,
  ToolDefinition,
  Session,
  ModelConfig,
  ExecutionContext,
} from "./types.ts"

// 工具模块
export { ToolRegistry } from "./tool/registry.ts"
export { ToolExecutor } from "./tool/executor.ts"

// Agent 模块
export { Agent } from "./agent/agent.ts"
export type { CreateAgentOptions } from "./agent/agent.ts"
export { runAgent } from "./agent/loop.ts"
export type { AgentConfig, AgentResult, AgentStep } from "./agent/loop.ts"
export { streamAgent } from "./agent/stream.ts"
export type { StreamAgentEvent } from "./agent/stream.ts"

// LLM 模块
export { LLMClient } from "./llm/client.ts"
export type { LLMCallInput, LLMCallOutput } from "./llm/client.ts"

// Session 模块
export { SessionManager } from "./session/session.ts"

// MCP 模块
export { MCPClient } from "./mcp/client.ts"
export type { MCPConfig } from "./mcp/client.ts"
export { adaptMCPTool } from "./mcp/adapter.ts"

// 工具
export { withRetry } from "./util/retry.ts"
```

## 4. 文件结构

```
src/
├── types.ts                    ✅ 已实现
├── index.ts                    📝 导出入口
├── agent/
│   ├── agent.ts                📝 Agent 类（面向用户）
│   ├── loop.ts                 📝 核心循环（非流式）
│   └── stream.ts               📝 流式循环
├── llm/
│   ├── client.ts               📝 OpenAI 封装 + 消息转换
│   └── stream.ts               📝 流式 LLM 调用
├── tool/
│   ├── registry.ts             ✅ 已实现
│   └── executor.ts             ✅ 已实现
├── mcp/
│   ├── client.ts               📝 MCP 客户端
│   └── adapter.ts              📝 MCP 工具适配
├── session/
│   └── session.ts              📝 会话管理
└── util/
    └── retry.ts                ✅ 已实现

examples/
├── basic.ts                    📝 基础使用
├── custom-tools.ts             📝 自定义工具
└── mcp-usage.ts               📝 MCP 集成
```

## 5. 示例设计

### 5.1 基础使用 (`examples/basic.ts`)

```typescript
import { Agent } from "../src/index.ts"

const agent = new Agent({
  model: "gpt-4o",
  systemPrompt: "You are a helpful assistant.",
})

// 非流式
const result = await agent.chat("你好，请介绍一下你自己")
console.log(result.finalContent)
```

### 5.2 自定义工具 (`examples/custom-tools.ts`)

```typescript
import { Agent } from "../src/index.ts"
import type { Tool } from "../src/index.ts"

const weatherTool: Tool = {
  name: "get_weather",
  description: "获取指定城市的天气信息",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  execute: async (args) => {
    const { city } = args as { city: string }
    return { output: JSON.stringify({ city, temp: 22, condition: "晴" }) }
  },
}

const calculatorTool: Tool = {
  name: "calculate",
  description: "执行数学计算",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式" },
    },
    required: ["expression"],
  },
  execute: async (args) => {
    const { expression } = args as { expression: string }
    // 安全起见，仅支持基础运算
    const result = Function(`"use strict"; return (${expression})`)()
    return { output: String(result) }
  },
}

const agent = new Agent({
  tools: [weatherTool, calculatorTool],
})

// 流式输出
for await (const event of agent.stream("北京天气如何？如果气温是22度，22 * 1.8 + 32 是多少？")) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.text)
      break
    case "tool_call_end":
      console.log(`\n[调用工具: ${event.name}]`)
      break
    case "tool_result":
      console.log(`[工具结果: ${event.results.map((r) => r.result).join(", ")}]`)
      break
    case "done":
      console.log(`\n[完成，共 ${event.steps} 步]`)
      break
  }
}
```

### 5.3 MCP 集成 (`examples/mcp-usage.ts`)

```typescript
import { Agent, MCPClient } from "../src/index.ts"

async function main() {
  // 连接 MCP 服务器（以 filesystem server 为例）
  const mcp = new MCPClient("filesystem-client")
  await mcp.connect({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  })

  // 从 MCP 加载工具
  const mcpTools = await mcp.listTools()

  // 创建 Agent
  const agent = new Agent({
    tools: mcpTools,
    systemPrompt: "你可以使用文件系统工具来读写文件。",
  })

  const result = await agent.chat("请在 /tmp 目录下创建一个 hello.txt 文件，内容是 Hello MCP!")
  console.log(result.finalContent)

  await mcp.disconnect()
}

main()
```

## 6. 实现顺序

按依赖关系从底到顶：

| 步骤 | 模块 | 文件 | 依赖 |
|------|------|------|------|
| 1 | LLM 客户端 | `src/llm/client.ts` | types.ts, openai |
| 2 | 流式 LLM | `src/llm/stream.ts` | client.ts |
| 3 | 会话管理 | `src/session/session.ts` | types.ts, registry.ts |
| 4 | Agent 循环 | `src/agent/loop.ts` | llm, executor, retry |
| 5 | 流式 Agent | `src/agent/stream.ts` | llm/stream, executor |
| 6 | Agent 入口 | `src/agent/agent.ts` | loop, stream, session |
| 7 | MCP 客户端 | `src/mcp/client.ts` | @modelcontextprotocol/sdk |
| 8 | MCP 适配器 | `src/mcp/adapter.ts` | client.ts, types.ts |
| 9 | 包入口 | `src/index.ts` | 所有模块 |
| 10 | 示例 | `examples/*.ts` | index.ts |

## 7. 设计决策

### 7.1 为什么用 OpenAI 格式而非 Anthropic

- `institutions.md` 明确要求使用 OpenAI
- OpenAI 的 `tool_calls` 是 assistant message 的一部分，tool result 是独立的 tool message
- Anthropic 的 `tool_use` block 在 content 数组中，tool result 作为 user message 的一部分
- 两者概念模型不同，需要选择一种

### 7.2 消息历史直接存储

- Session 中直接保存完整 `Message[]`，不做截断
- 消息压缩/截断策略留给上层使用者决定
- 保持 SDK 简单，不做过多假设

### 7.3 Agent 类 vs 函数式 API

- 提供 `Agent` 类（面向用户的高层 API）和 `runAgent`/`streamAgent` 函数（底层 API）
- 类封装了 session、registry 的生命周期
- 函数式 API 提供更大的灵活性

### 7.4 工具执行顺序

- 同一轮中的多个工具调用**并行执行**（`Promise.all`）
- 这与 OpenAI 的行为一致：一个 assistant turn 可以包含多个 tool_calls
- 工具之间如果存在依赖，由 LLM 在不同 step 中顺序调用

### 7.5 错误处理策略

- 工具执行错误**不抛出**，而是返回 `ToolResultContent { isError: true }`
- 将错误信息返回给 LLM，让模型决定下一步（重试/换方案/告知用户）
- LLM 调用失败通过 `withRetry` 自动重试
- 超过 `maxSteps` 则停止并返回当前结果
