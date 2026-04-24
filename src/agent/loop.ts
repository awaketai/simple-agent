import { v4 as uuid } from "uuid"
import type {
  Message,
  MessageContent,
  ModelConfig,
  Session,
  Tool,
  ToolCallContent,
  ToolResultContent,
} from "../types.ts"
import { streamLLM } from "../llm/client.ts"
import { ToolExecutor } from "../tool/executor.ts"
import { ToolRegistry } from "../tool/registry.ts"

export interface AgentConfig {
  model: string
  systemPrompt: string
  tools: Tool[]
  apiKey?: string | undefined
  baseURL?: string | undefined
  maxSteps?: number | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
}

export type AgentEvent =
  | { type: "message_start"; role: "assistant" }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: string }
  | { type: "message_end"; finishReason: string }
  | { type: "error"; error: Error }

export function createSession(
  config: AgentConfig,
): Session {
  const registry = new ToolRegistry()
  for (const tool of config.tools) {
    registry.register(tool)
  }

  const model: ModelConfig = { name: config.model }
  if (config.maxTokens !== undefined) model.maxTokens = config.maxTokens
  if (config.temperature !== undefined) model.temperature = config.temperature

  return {
    id: uuid(),
    messages: [],
    systemPrompt: config.systemPrompt,
    model,
    tools: config.tools,
    status: "idle",
  }
}

export async function* streamAgent(
  session: Session,
  config: AgentConfig,
): AsyncGenerator<AgentEvent> {
  const registry = new ToolRegistry()
  for (const tool of config.tools) {
    registry.register(tool)
  }
  const executor = new ToolExecutor(registry)
  const maxSteps = config.maxSteps ?? 200
  let step = 0

  while (step < maxSteps) {
    step++
    yield { type: "message_start", role: "assistant" }

    const content: MessageContent[] = []
    let textAccumulator = ""
    const toolCallBuilders: Map<
      number,
      { id: string; name: string; args: string }
    > = new Map()
    let finishReason = "stop"

    try {
      for await (const event of streamLLM({
        model: config.model,
        messages: session.messages,
        systemPrompt: config.systemPrompt,
        tools: registry.toToolDefinitions(),
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      })) {
        switch (event.type) {
          case "text_delta":
            textAccumulator += event.text
            yield { type: "text", text: event.text }
            break
          case "tool_call_start":
            toolCallBuilders.set(toolCallBuilders.size, {
              id: event.id,
              name: event.name,
              args: "",
            })
            break
          case "tool_call_delta": {
            for (const [, b] of toolCallBuilders) {
              if (b.id === event.id) {
                b.args += event.arguments
                break
              }
            }
            break
          }
          case "tool_call_end": {
            break
          }
          case "finish":
            finishReason = event.reason
            yield { type: "message_end", finishReason: event.reason }
            break
          case "error":
            yield { type: "error", error: event.error }
            session.status = "error"
            return
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      yield { type: "error", error: err }
      session.status = "error"
      return
    }

    // Build assistant message content
    if (textAccumulator) {
      content.push({ type: "text", text: textAccumulator })
    }

    const toolCalls: ToolCallContent[] = []
    for (const [, builder] of toolCallBuilders) {
      let parsedArgs: unknown
      try {
        parsedArgs = JSON.parse(builder.args)
      } catch {
        parsedArgs = builder.args
      }
      const call: ToolCallContent = {
        type: "tool_call",
        id: builder.id,
        name: builder.name,
        arguments: parsedArgs,
      }
      content.push(call)
      toolCalls.push(call)
      yield { type: "tool_call", name: builder.name, args: parsedArgs }
    }

    session.messages.push({
      id: uuid(),
      role: "assistant",
      content,
      createdAt: new Date(),
    })

    // No tool calls → done
    if (toolCalls.length === 0) {
      session.status = "completed"
      break
    }

    // Execute tool calls in parallel
    const results: ToolResultContent[] = await executor.executeAll(toolCalls, {
      sessionId: session.id,
      messageId: session.messages[session.messages.length - 1]!.id,
    })

    for (const r of results) {
      const toolName = toolCalls.find(
        (tc) => tc.id === r.toolCallId,
      )?.name ?? "unknown"
      yield { type: "tool_result", name: toolName, result: r.result }
    }

    session.messages.push({
      id: uuid(),
      role: "tool",
      content: results,
      createdAt: new Date(),
    })
  }

  if (step >= (config.maxSteps ?? 200)) {
    yield {
      type: "error",
      error: new Error(`Agent exceeded maximum steps (${config.maxSteps ?? 200})`),
    }
    session.status = "error"
  }
}

export async function runAgent(
  session: Session,
  config: AgentConfig,
): Promise<Message[]> {
  const events: AgentEvent[] = []
  for await (const event of streamAgent(session, config)) {
    events.push(event)
  }
  return session.messages
}
