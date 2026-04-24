/**
 * Basic usage example: a simple agent with a built-in tool.
 *
 * Configure .env with your API credentials, then run:
 *   pnpm example:basic
 */
import {
  createSession,
  streamAgent,
  type Tool,
} from "../src/index.ts"

const model = process.env.MODEL ?? "gpt-4o-mini"

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
    const data: Record<string, { temp: number; condition: string }> = {
      tokyo: { temp: 22, condition: "sunny" },
      london: { temp: 14, condition: "rainy" },
      "new york": { temp: 18, condition: "cloudy" },
    }
    const weather = data[city.toLowerCase()] ?? {
      temp: 20,
      condition: "unknown",
    }
    return {
      output: JSON.stringify({
        city,
        temperature: weather.temp,
        condition: weather.condition,
      }),
    }
  },
}

const systemPrompt = "You are a helpful weather assistant. Use the get_weather tool when asked about weather."

async function main() {
  const session = createSession({
    model,
    systemPrompt,
    tools: [getWeatherTool],
  })

  session.messages.push({
    id: "user-1",
    role: "user",
    content: [{ type: "text", text: "What's the weather in Tokyo?" }],
    createdAt: new Date(),
  })

  console.log("User: What's the weather in Tokyo?\n")

  for await (const event of streamAgent(session, {
    model,
    systemPrompt,
    tools: [getWeatherTool],
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
        break
      case "message_end":
        console.log()
        break
      case "error":
        console.error("Error:", event.error.message)
        break
    }
  }
}

main().catch(console.error)
