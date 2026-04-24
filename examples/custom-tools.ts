/**
 * Custom tools example: multi-turn agent with multiple tools.
 *
 * Configure .env with your API credentials, then run:
 *   pnpm example:custom-tools
 */
import {
  createSession,
  streamAgent,
  type Tool,
} from "../src/index.ts"

const model = process.env.MODEL ?? "gpt-4o-mini"

// Tool 1: Calculator
const calculatorTool: Tool = {
  name: "calculator",
  description: "Evaluate a mathematical expression and return the result",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "A mathematical expression, e.g. '2 + 3 * 4'",
      },
    },
    required: ["expression"],
  },
  execute: async (args) => {
    const { expression } = args as { expression: string }
    try {
      // Safe eval using Function constructor (only math expressions)
      const result = new Function(`return (${expression})`)()
      return { output: String(result) }
    } catch {
      return { output: "Invalid expression", error: "Invalid expression" }
    }
  },
}

// Tool 2: String reverser
const reverseTool: Tool = {
  name: "reverse_string",
  description: "Reverse a given string",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to reverse" },
    },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string }
    return { output: text.split("").reverse().join("") }
  },
}

// Tool 3: Word counter
const wordCountTool: Tool = {
  name: "count_words",
  description: "Count the number of words in a given text",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to count words in" },
    },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string }
    const count = text.trim().split(/\s+/).length
    return { output: String(count) }
  },
}

const tools = [calculatorTool, reverseTool, wordCountTool]

const systemPrompt = `You are a helpful assistant with access to three tools:
1. calculator - evaluate math expressions
2. reverse_string - reverse any text
3. count_words - count words in text

Use the appropriate tool when the user asks. Explain your reasoning briefly.`

async function chat(userInput: string, session: ReturnType<typeof createSession>) {
  session.messages.push({
    id: `user-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: userInput }],
    createdAt: new Date(),
  })

  console.log(`\nUser: ${userInput}`)
  process.stdout.write("Assistant: ")

  let hasToolActivity = false

  for await (const event of streamAgent(session, {
    model,
    systemPrompt,
    tools,
  })) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text)
        break
      case "tool_call":
        hasToolActivity = true
        console.log(`\n[Calling ${event.name}(${JSON.stringify(event.args)})]`)
        process.stdout.write("Result: ")
        break
      case "tool_result":
        if (hasToolActivity) {
          console.log(event.result)
          process.stdout.write("Assistant: ")
          hasToolActivity = false
        }
        break
      case "error":
        console.error("Error:", event.error.message)
        break
    }
  }

  console.log()
  return session
}

async function main() {
  const session = createSession({
    model,
    systemPrompt,
    tools,
  })

  // Multi-turn conversation
  await chat("What is 123 * 456 + 789?", session)
  await chat("Now reverse the string 'Hello World'", session)
  await chat("How many words are in the sentence: 'The quick brown fox jumps over the lazy dog'?", session)
  await chat("What was the result of the first calculation?", session)
}

main().catch(console.error)
