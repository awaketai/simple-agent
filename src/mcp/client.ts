import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Tool, ToolResult, JSONSchema } from "../types.ts"

interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: "object"
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

export interface MCPStdioConfig {
  transport: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPHTTPConfig {
  transport: "http"
  url: string
}

export type MCPConfig = MCPStdioConfig | MCPHTTPConfig

export class MCPClient {
  private client: Client
  private connected = false

  constructor(name: string, version = "1.0.0") {
    this.client = new Client({ name, version })
  }

  async connect(config: MCPConfig): Promise<void> {
    if (config.transport === "stdio") {
      const params: { command: string; args?: string[]; env?: Record<string, string> } = {
        command: config.command,
      }
      if (config.args) params.args = config.args
      if (config.env) params.env = config.env
      const transport = new StdioClientTransport(params)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client.connect(transport as any)
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(config.url))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client.connect(transport as any)
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close()
      this.connected = false
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const allTools: MCPToolDefinition[] = []
    let cursor: string | undefined
    do {
      const result = await this.client.listTools({ cursor })
      allTools.push(...(result.tools as MCPToolDefinition[]))
      cursor = result.nextCursor
    } while (cursor)
    return allTools
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    try {
      const result = await this.client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      })

      const contentItems = result.content as Array<{
        type: string
        text?: string
      }>

      if (result.isError) {
        const text = contentItems
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n")
        return { output: text, error: "Tool execution error" }
      }

      const output = contentItems
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n")

      return { output: output || JSON.stringify(result.content) }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { output: msg, error: msg }
    }
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions()
  }
}

export function adaptMCPTool(
  client: MCPClient,
  mcpTool: MCPToolDefinition,
): Tool {
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: (mcpTool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as JSONSchema,
    execute: async (args) => {
      return await client.callTool(mcpTool.name, args)
    },
  }
}

export async function loadMCPTools(
  config: MCPConfig & { name?: string },
): Promise<{ tools: Tool[]; client: MCPClient }> {
  const client = new MCPClient(config.name ?? "simple-agent-mcp")
  await client.connect(config)
  const mcpTools = await client.listTools()
  const tools = mcpTools.map((t) => adaptMCPTool(client, t))
  return { tools, client }
}
