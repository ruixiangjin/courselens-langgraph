import assert from 'node:assert/strict'
import test from 'node:test'
import { AIMessage } from '@langchain/core/messages'
import { createStudyApplication } from '@monash-study/study-application'
import { InMemoryAgentEventSink } from '@monash-study/study-core'
import type { StudyChatModel } from '@monash-study/langgraph-runtime'

const evidence = {
  evidenceId: 'fit2004-lecture', title: 'Unweighted graphs', content: 'BFS gives shortest paths in unweighted graphs.',
  course: 'FIT2004', sourceSystem: 'local' as const, retrievalProvider: 'local' as const, metadata: {},
}

test('routes a general question directly to the tutor', async () => {
  const calls: string[] = []
  const sink = new InMemoryAgentEventSink()
  const app = await createStudyApplication({
    memoryService: null, knowledgeService: null, resourceReader: null, eventSink: sink,
    model: async messages => {
      const role = messages[0]?.text.includes('Role: understanding') ? 'understanding' : 'tutor'
      calls.push(role)
      return new AIMessage(JSON.stringify(role === 'understanding'
        ? { intent: 'explain', objective: 'Explain BFS' }
        : { answer: 'BFS visits vertices layer by layer.', evidenceIds: [] }))
    },
  })
  try {
    const result = await app.runTurn({ query: 'Explain BFS' })
    assert.deepEqual(calls, ['understanding', 'tutor'])
    assert.equal(result.promptVersion, 'study-supervisor-v1')
    assert.equal(sink.events.find(event => event.type === 'study_routed')?.route, 'explain')
  } finally { await app.close() }
})

test('the verifier sends a focused repair back to research and only publishes the revised answer', async () => {
  const searches: string[] = []
  const objectives: string[] = []
  let reviews = 0
  const model: StudyChatModel = async (messages, _profile, _signal, tools) => {
    const prompt = messages[0]?.text ?? ''
    const data = messages[1]?.text ?? '{}'
    if (prompt.includes('Role: understanding')) return new AIMessage(JSON.stringify({ intent: 'verify_and_plan', objective: 'Find BFS evidence' }))
    if (prompt.includes('Role: study planner')) return new AIMessage(JSON.stringify({
      goal: 'Practise BFS', exercises: [{ activity: 'Trace a graph', minutes: 15, checkpoint: 'Explain the queue' }],
    }))
    if (prompt.includes('Role: tutor')) return new AIMessage(JSON.stringify({
      answer: objectives.length === 1 ? 'BFS always works [fit2004-lecture].' : 'BFS works on unweighted graphs [fit2004-lecture].',
      evidenceIds: [evidence.evidenceId],
    }))
    if (prompt.includes('Role: independent verifier')) {
      reviews += 1
      return new AIMessage(JSON.stringify(reviews === 1
        ? { decision: 'repair', reason: 'Find the unweighted graph condition', needsEvidence: true }
        : { decision: 'accept', reason: 'Evidence supports the revised answer', needsEvidence: false }))
    }
    const task = JSON.parse(data.split('\n')[1] ?? '{}') as { taskId: string; objective: string }
    if (messages.at(-1)?.type === 'tool') return new AIMessage(JSON.stringify({
      taskId: task.taskId, summary: evidence.content, evidenceIds: [evidence.evidenceId], limitations: [],
      findings: [{ content: evidence.content, evidenceIds: [evidence.evidenceId] }],
    }))
    assert.ok(tools?.some(tool => tool.name === 'search_knowledge'))
    objectives.push(task.objective)
    return new AIMessage({ content: '', tool_calls: [{ name: 'search_knowledge', id: task.taskId, args: { query: task.objective } }] })
  }
  const app = await createStudyApplication({
    memoryService: null, resourceReader: null, model,
    knowledgeService: { async search({ query, course }) {
      assert.equal(course, 'FIT2004')
      searches.push(query)
      return [evidence]
    } },
  })
  try {
    const result = await app.runTurn({ query: 'Check the BFS lecture and plan practice', courseContext: { courseCode: 'FIT2004' } })
    assert.deepEqual(searches, ['Find BFS evidence', 'Find the unweighted graph condition'])
    assert.equal(reviews, 2)
    assert.equal(result.answer, 'BFS works on unweighted graphs [fit2004-lecture].')
    assert.deepEqual(result.evidence, [evidence])
    assert.equal(result.plan?.exercises[0]?.minutes, 15)
  } finally { await app.close() }
})
