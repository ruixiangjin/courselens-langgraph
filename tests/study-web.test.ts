import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createStudyPersistence } from '@monash-study/langgraph-runtime'
import { createStudyApplication } from '@monash-study/study-application'
import { createStudyServer } from '../packages/study-api/src/index.js'
import { StudyStore } from '../packages/study-api/src/store.js'
import { buildCardsOverMcp } from '../packages/study-jobs/src/mcp.js'
import { runStudyJob } from '../packages/study-jobs/src/worker.js'
import { demoKnowledge, demoModel } from './fixtures/courselens-demo.js'

test('MCP tool creates review cards from a plan', async () => {
  const result = await buildCardsOverMcp({ goal: 'BFS', exercises: [{ activity: 'Trace BFS', minutes: 15, checkpoint: 'List distances' }] })
  assert.deepEqual(result, [{ goal: 'BFS', prompt: 'Trace BFS', minutes: 15, check: 'List distances' }])
})

const database = process.env.COURSELENS_TEST_DATABASE_URL
test('web study turns enforce ownership, replay events, approve once and recover a job', { skip: !database }, async () => {
  const store = new StudyStore(database!)
  const persistence = createStudyPersistence(database!)
  await store.setup()
  await persistence.setup()
  const application = await createStudyApplication({
    checkpointer: persistence.checkpointer, sessions: persistence.sessions,
    model: demoModel, knowledgeService: demoKnowledge, resourceReader: null, memoryService: null,
  })
  const api = await createStudyServer({
    store, applicationFor: async () => application, principals: [
      { student: 'a', token: 'alpha', role: 'student' },
      { student: 'b', token: 'bravo', role: 'student' },
      { student: 'ops', token: 'operator', role: 'operator' },
    ],
  })
  try {
    const headers = { authorization: 'Bearer alpha' }
    const other = { authorization: 'Bearer bravo' }
    const turn = randomUUID()
    const payload = { session: randomUUID(), turn, course: 'FIT2004', question: 'Check the lecture and plan practice.' }
    const first = await api.inject({ method: 'POST', url: '/api/turns', headers, payload })
    assert.equal(first.statusCode, 200, first.body)
    assert.match(first.json().answer, /unweighted/)
    assert.ok(first.json().plan)
    const retry = await api.inject({ method: 'POST', url: '/api/turns', headers, payload })
    assert.deepEqual(retry.json(), first.json())
    assert.equal((await api.inject({ method: 'POST', url: '/api/turns', headers: other, payload })).statusCode, 404)
    const events = await api.inject({ url: '/api/turns/' + turn + '/events', headers })
    assert.match(events.body, /study_routed/)
    assert.match(events.body, /run_completed/)
    assert.equal((await api.inject({ url: '/api/trace', headers })).statusCode, 403)
    assert.equal((await api.inject({ url: '/api/trace', headers: { authorization: 'Bearer operator' } })).statusCode, 200)
    for (let index = 0; index < 2; index += 1) {
      const approve = await api.inject({ method: 'POST', url: '/api/turns/' + turn + '/approve', headers })
      assert.equal(approve.statusCode, 202)
    }
    await store.pool.query("UPDATE courselens.study_jobs SET status='running',attempts=1,lease_until=now()-interval '1 second' WHERE id=$1", [turn])
    const runs = await Promise.all([runStudyJob(store.pool, buildCardsOverMcp), runStudyJob(store.pool, buildCardsOverMcp)])
    assert.equal(runs.filter(Boolean).length, 1)
    const job = await api.inject({ url: '/api/jobs/' + turn, headers })
    assert.equal(job.json().status, 'done')
    assert.equal(job.json().attempts, 2)
    assert.equal(job.json().result.length, 2)
    assert.equal((await api.inject({ url: '/api/jobs/' + turn, headers: other })).statusCode, 404)
  } finally {
    await api.close()
    await application.close()
    await persistence.close()
    await store.close()
  }
})
