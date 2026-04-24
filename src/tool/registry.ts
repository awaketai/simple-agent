import type { Tool, ToolDefinition } from "../types.ts"

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  toToolDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }
}
