/**
 * Debug: test raw OpenAI connection
 * Run: OPENAI_API_KEY=your-key OPENAI_BASE_URL=https://your-proxy/v1 tsx examples/debug-openai.ts
 */
import OpenAI from "openai"

async function main() {
  console.log("OPENAI_API_KEY set:", !!process.env.OPENAI_API_KEY)
  console.log("OPENAI_BASE_URL:", process.env.OPENAI_BASE_URL ?? "(not set)")
  console.log()

  const client = new OpenAI()
  console.log("Client baseURL:", client.baseURL)
  console.log()

  console.log("Calling OpenAI...")
  try {
    const stream = await client.chat.completions.create({
      model: process.env.MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hi in 3 words" }],
      max_tokens: 32,
      stream: true,
    })

    let gotChunks = false
    for await (const chunk of stream) {
      gotChunks = true
      const text = chunk.choices[0]?.delta?.content ?? ""
      if (text) process.stdout.write(text)
    }
    console.log("\nStream done. gotChunks:", gotChunks)
  } catch (error) {
    console.error("OpenAI error:", error)
  }
}

main().catch(console.error)
