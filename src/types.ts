export interface TextContent {
  type: "text"
  text: string
}

export interface ToolCallContent {
  type: "tool_call"
  id: string
  name: string
  arguments: unknown
}

export interface ToolResultContent {
  type: "tool_result"
  toolCallId: string
  result: string
  isError?: boolean
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent

export interface Message {
  id: string
  role: "user" | "assistant" | "tool"
  content: MessageContent[]
  createdAt: Date
}

export interface ToolResult {
  output: string
  metadata?: Record<string, unknown>
  error?: string
}

export interface JSONSchema {
  type: "object"
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  execute: (args: unknown) => Promise<ToolResult>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JSONSchema
}

export interface Session {
  id: string
  messages: Message[]
  systemPrompt: string
  model: ModelConfig
  tools: Tool[]
  status: "idle" | "running" | "completed" | "error"
}

export interface ModelConfig {
  name: string
  maxTokens?: number | undefined
  temperature?: number | undefined
}

export interface ExecutionContext {
  sessionId: string
  messageId: string
  abortSignal?: AbortSignal
}
