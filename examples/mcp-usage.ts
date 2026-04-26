import "dotenv/config"

/**
 * MCP integration example: connect to MCP servers and use their tools.
 *
 * Configure .env with your API credentials, then run:
 *   pnpm example:mcp
 */
import {
  createSession,
  streamAgent,
  loadMCPTools,
  type Tool,
} from "../src/index.ts"

const model = process.env.MODEL ?? "gpt-4o-mini"

// A local custom tool that works alongside MCP tools
const summarizeTool: Tool = {
  name: "summarize",
  description: "Summarize a given text in one sentence",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to summarize" },
    },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string }
    // Simple heuristic: take first sentence + word count
    const firstSentence = text.split(/[.!?]/)[0] ?? ""
    const wordCount = text.trim().split(/\s+/).length
    return {
      output: `Summary: "${firstSentence}." (${wordCount} words total)`,
    }
  },
}

async function main() {
  const allTools: Tool[] = [summarizeTool]
  const mcpClients: Array<{ disconnect: () => Promise<void> }> = []

  // --- Load tools from MCP servers ---
  // Example 1: filesystem MCP server (reads files from a directory)
  // Uncomment and adjust the path to use a real MCP filesystem server:
  //
  // try {
  //   const { tools, client } = await loadMCPTools({
  //     transport: "stdio",
  //     command: "npx",
  //     args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  //     name: "filesystem-mcp",
  //   })
  //   allTools.push(...tools)
  //   mcpClients.push(client)
  //   console.log(`Loaded ${tools.length} tools from filesystem MCP server`)
  // } catch (error) {
  //   console.warn("Could not connect to filesystem MCP server:", error)
  // }

  // Example 2: HTTP-based MCP server
  // Uncomment if you have an MCP server running on HTTP:
  //
  // try {
  //   const { tools, client } = await loadMCPTools({
  //     transport: "http",
  //     url: "http://localhost:3000/mcp",
  //     name: "remote-mcp",
  //   })
  //   allTools.push(...tools)
  //   mcpClients.push(client)
  //   console.log(`Loaded ${tools.length} tools from HTTP MCP server`)
  // } catch (error) {
  //   console.warn("Could not connect to HTTP MCP server:", error)
  // }

  // For demo purposes, we'll just use the local tool
  console.log(`Available tools: ${allTools.map((t) => t.name).join(", ")}\n`)

  const session = createSession({
    model,
    systemPrompt:
      "You are a helpful assistant. You have tools to help with file operations (if MCP is connected) and text summarization.",
    tools: allTools,
  })

  // Add user message
  session.messages.push({
    id: "user-1",
    role: "user",
    content: [
      {
        type: "text",
        text: "Please summarize this text: 'Artificial intelligence is transforming how we build software. Modern AI agents can understand natural language, call external tools, and complete complex multi-step tasks autonomously. This represents a fundamental shift from traditional programming to intent-driven development.'",
      },
    ],
    createdAt: new Date(),
  })

  console.log("User: Please summarize the text about AI...\n")

  for await (const event of streamAgent(session, {
    model,
    systemPrompt: session.systemPrompt,
    tools: allTools,
  })) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text)
        break
      case "tool_call":
        console.log(`\n[Tool Call] ${event.name}(${JSON.stringify(event.args)})`)
        break
      case "tool_result":
        console.log(`[Tool Result] ${event.name}: ${event.result}`)
        process.stdout.write("Assistant: ")
        break
      case "error":
        console.error("Error:", event.error.message)
        break
    }
  }

  console.log()

  // Cleanup: disconnect all MCP clients
  for (const client of mcpClients) {
    await client.disconnect()
  }
}

main().catch(console.error)
