import OpenAI from "openai"
import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolDefinition,
  ToolResultContent,
} from "../types.ts"

export interface LLMInput {
  model: string
  messages: Message[]
  systemPrompt: string
  tools: ToolDefinition[]
  apiKey?: string | undefined
  baseURL?: string | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
  abortSignal?: AbortSignal | undefined
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: string }
  | { type: "finish"; reason: string; usage: Usage }
  | { type: "error"; error: Error }

export interface LLMOutput {
  content: MessageContent[]
  finishReason: "stop" | "tool_calls" | "max_tokens" | "error"
  usage: Usage
}

function toOpenAIMessages(
  messages: Message[],
  systemPrompt: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ]

  for (const msg of messages) {
    if (msg.role === "user") {
      const texts = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
      if (texts.length > 0) {
        result.push({ role: "user", content: texts.join("\n") })
      }

      const toolResults = msg.content.filter(
        (c): c is ToolResultContent => c.type === "tool_result",
      )
      for (const r of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: r.toolCallId,
          content: r.result,
        })
      }
    } else if (msg.role === "assistant") {
      const textParts = msg.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      )
      const toolParts = msg.content.filter(
        (c): c is ToolCallContent => c.type === "tool_call",
      )

      const content: string | null =
        textParts.length > 0 ? textParts.map((t) => t.text).join("") : null

      if (toolParts.length > 0) {
        result.push({
          role: "assistant",
          content,
          tool_calls: toolParts.map((t) => ({
            id: t.id,
            type: "function" as const,
            function: {
              name: t.name,
              arguments:
                typeof t.arguments === "string"
                  ? t.arguments
                  : JSON.stringify(t.arguments),
            },
          })),
        })
      } else if (content) {
        result.push({ role: "assistant", content })
      }
    }
  }

  return result
}

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

export async function* streamLLM(
  input: LLMInput,
): AsyncGenerator<LLMEvent> {
  const clientOptions: Record<string, string> = {}
  if (input.apiKey) clientOptions.apiKey = input.apiKey
  if (input.baseURL) clientOptions.baseURL = input.baseURL
  const client = new OpenAI(clientOptions)
  const openaiMessages = toOpenAIMessages(input.messages, input.systemPrompt)

  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: input.model,
    messages: openaiMessages,
    max_tokens: input.maxTokens ?? 4096,
    temperature: input.temperature ?? 0,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (input.tools.length > 0) {
    params.tools = toOpenAITools(input.tools)
  }

  const stream = await client.chat.completions.create(
    params,
    { signal: input.abortSignal ?? undefined },
  )

  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  const toolCallBuilders: Map<
    number,
    { id: string; name: string; args: string }
  > = new Map()

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      }
    }

    if (!delta) continue

    if (delta.content) {
      yield { type: "text_delta", text: delta.content }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index
        if (tc.id && tc.function?.name) {
          toolCallBuilders.set(idx, {
            id: tc.id,
            name: tc.function.name,
            args: "",
          })
          yield {
            type: "tool_call_start",
            id: tc.id,
            name: tc.function.name,
          }
        }
        if (tc.function?.arguments) {
          const builder = toolCallBuilders.get(idx)
          if (builder) {
            builder.args += tc.function.arguments
            yield {
              type: "tool_call_delta",
              id: builder.id,
              arguments: tc.function.arguments,
            }
          }
        }
      }
    }

    if (choice?.finish_reason) {
      for (const [, builder] of toolCallBuilders) {
        yield {
          type: "tool_call_end",
          id: builder.id,
          name: builder.name,
          arguments: builder.args,
        }
      }
      yield {
        type: "finish",
        reason: choice.finish_reason,
        usage,
      }
    }
  }
}

export async function callLLM(input: LLMInput): Promise<LLMOutput> {
  const content: MessageContent[] = []
  let textAccumulator = ""
  const toolCallBuilders: Map<
    number,
    { id: string; name: string; args: string }
  > = new Map()
  let finishReason = "stop"
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }

  for await (const event of streamLLM(input)) {
    switch (event.type) {
      case "text_delta":
        textAccumulator += event.text
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
        // finalize handled in finish
        break
      }
      case "finish":
        finishReason = event.reason
        usage = event.usage
        break
      case "error":
        throw event.error
    }
  }

  if (textAccumulator) {
    content.push({ type: "text", text: textAccumulator })
  }

  for (const [, builder] of toolCallBuilders) {
    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(builder.args)
    } catch {
      parsedArgs = builder.args
    }
    content.push({
      type: "tool_call",
      id: builder.id,
      name: builder.name,
      arguments: parsedArgs,
    })
  }

  return {
    content,
    finishReason: finishReason as LLMOutput["finishReason"],
    usage,
  }
}
