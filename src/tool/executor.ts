import type {
  ExecutionContext,
  ToolCallContent,
  ToolResultContent,
} from "../types.ts"
import { ToolRegistry } from "./registry.ts"

export class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(
    call: ToolCallContent,
    ctx: ExecutionContext,
  ): Promise<ToolResultContent> {
    const tool = this.registry.get(call.name)
    if (!tool) {
      return {
        type: "tool_result",
        toolCallId: call.id,
        result: `Tool not found: ${call.name}`,
        isError: true,
      }
    }

    try {
      const result = await tool.execute(call.arguments)
      return {
        type: "tool_result",
        toolCallId: call.id,
        result: result.output,
        isError: !!result.error,
      }
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : String(error)
      return {
        type: "tool_result",
        toolCallId: call.id,
        result: msg,
        isError: true,
      }
    }
  }

  async executeAll(
    calls: ToolCallContent[],
    ctx: ExecutionContext,
  ): Promise<ToolResultContent[]> {
    return Promise.all(calls.map((call) => this.execute(call, ctx)))
  }
}
