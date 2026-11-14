import { performance } from 'node:perf_hooks'
import { createStudyApplication } from '@monash-study/study-application'
import { InMemoryAgentEventSink } from '@monash-study/study-core'
import { demoKnowledge, demoModel } from '../tests/fixtures/courselens-demo.js'

const cases = [
  { question: 'Explain BFS', route: 'explain', citation: false, plan: false },
  { question: 'Check the lecture on BFS', route: 'verify_sources', citation: true, plan: false },
  { question: 'Check the lecture and plan practice', route: 'verify_and_plan', citation: true, plan: true },
  { question: 'Check the tutorial on BFS', route: 'verify_sources', citation: true, plan: false },
] as const

const app = await createStudyApplication({
  model: demoModel, knowledgeService: demoKnowledge, memoryService: null, resourceReader: null,
})
try {
  const results = []
  for (const expected of cases) {
    const sink = new InMemoryAgentEventSink()
    const start = performance.now()
    const result = await app.runTurn({ query: expected.question, courseContext: { courseCode: 'FIT2004' } }, { eventSink: sink })
    const route = sink.events.find(event => event.type === 'study_routed')?.route
    const citation = result.evidence.some(item => item.evidenceId === 'demo-bfs')
    const plan = Boolean(result.plan)
    const repaired = sink.events.filter(event => event.type === 'subagent_started').length === 2
    results.push({
      question: expected.question, route, citation, plan, repaired,
      passed: route === expected.route && citation === expected.citation && plan === expected.plan
        && (!expected.citation || repaired && /unweighted/u.test(result.answer)),
      fixtureMs: Math.round(performance.now() - start),
    })
  }
  console.log(JSON.stringify({ mode: 'scripted integration replay', passed: results.filter(item => item.passed).length, total: cases.length, results }, null, 2))
  if (results.some(item => !item.passed)) process.exitCode = 1
} finally { await app.close() }
