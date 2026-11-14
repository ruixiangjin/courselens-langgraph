import assert from 'node:assert/strict'
import test from 'node:test'

import { AIMessage } from '@langchain/core/messages'
import { createStudyApplication } from '@monash-study/study-application'
import { InMemoryAgentEventSink, StudyRuntimeError } from '@monash-study/study-core'

import {
  completedTurnEvents,
  fixtureEvidence,
  fixtureKnowledge,
  fixtureModel,
  studyQuestion,
} from './fixtures/runtime-parity.js'

test('runs a direct graph turn through the application and emits one terminal event', async () => {
  const sink = new InMemoryAgentEventSink()
  const app = await createStudyApplication({
    mode: 'legacy',
    model: async () => new AIMessage('Graph answer'),
    knowledgeService: null, resourceReader: null, memoryService: null,
    eventSink: sink,
  })
  try {
    const result = await app.runTurn(studyQuestion)
    assert.equal(result.answer, 'Graph answer')
    assert.deepEqual(sink.events.map(event => event.type), completedTurnEvents)
    await assert.rejects(
      app.runTurn({ ...studyQuestion, courseContext: { courseCode: 'OTHER' }, conversation: result.conversation }),
      (error: unknown) => error instanceof StudyRuntimeError && error.code === 'SESSION_ERROR',
    )
  } finally {
    await app.close()
  }
})

test('collects cited evidence from a delegated research tool round trip', async () => {
  const sink = new InMemoryAgentEventSink()
  const app = await createStudyApplication({
    mode: 'legacy',
    model: fixtureModel('research'),
    knowledgeService: fixtureKnowledge, resourceReader: null, memoryService: null,
    eventSink: sink,
  })
  try {
    const result = await app.runTurn(studyQuestion)
    assert.deepEqual(result.subagentsUsed, ['research'])
    assert.deepEqual(result.toolsUsed, ['research_subagent', 'search_knowledge'])
    assert.deepEqual(result.evidence, [fixtureEvidence])
    assert.match(result.answer, /backup-schedule/)
    assert.equal(result.researchActions, 1)
    assert.equal(sink.events.filter(event => event.type === 'subagent_completed').length, 1)
  } finally {
    await app.close()
  }
})

test('reads study memory through the application and keeps it out of evidence', async () => {
  let recalls = 0
  let observations = 0
  const app = await createStudyApplication({
    mode: 'legacy',
    model: fixtureModel('memory'),
    knowledgeService: null, resourceReader: null, memoryService: null,
    memoryReader: { async recall() { recalls += 1; return [] } },
    postTurnObserver: { async observe() { observations += 1 } },
  })
  try {
    const result = await app.runTurn(studyQuestion)
    assert.deepEqual(result.toolsUsed, ['recall_memory'])
    assert.deepEqual(result.evidence, [])
    assert.ok(recalls >= 2)
    assert.equal(observations, 1)
  } finally {
    await app.close()
  }
})
