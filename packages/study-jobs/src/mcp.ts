import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { StudyTurnResult } from '@monash-study/study-core'

type Plan = NonNullable<StudyTurnResult['plan']>
const planSchema = z.object({
  goal: z.string().min(1),
  exercises: z.array(z.object({
    activity: z.string().min(1), checkpoint: z.string().min(1), minutes: z.number().int().positive(),
  })).min(1).max(5),
})
const toolName = 'build_review_cards'

export async function buildCardsOverMcp(plan: Plan) {
  const server = new Server({ name: 'courselens-study-tools', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: toolName, description: 'Build review cards from an approved plan.', inputSchema: z.toJSONSchema(planSchema) as { type: 'object' } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== toolName) throw new Error('Unknown study tool.')
    const { goal, exercises } = planSchema.parse(request.params.arguments)
    return { content: [{ type: 'text' as const, text: JSON.stringify(exercises.map(exercise => ({
      goal, prompt: exercise.activity, check: exercise.checkpoint, minutes: exercise.minutes,
    }))) }] }
  })
  const client = new Client({ name: 'courselens-job-worker', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const reply = await client.callTool({ name: toolName, arguments: plan }, undefined, { timeout: 10_000 })
    const cards = z.object({
      isError: z.literal(false).optional(),
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })).length(1),
    }).parse(reply)
    return JSON.parse(cards.content[0]!.text) as unknown
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
}
