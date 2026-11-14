import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DefaultModelPolicy,
  InMemoryAgentEventSink,
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  renderMainStudyAgentPrompt,
  StudyRuntimeError,
  type StudyAgentRuntime,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'

test('Main Study Agent prompt keeps version, course context, and query invariants', () => {
  const rendered = renderMainStudyAgentPrompt({
    query: 'Explain branches.',
    courseContext: { courseCode: 'FIT2109', week: 4, topic: 'Git' },
  })
  assert.equal(MAIN_STUDY_AGENT_PROMPT_VERSION, 'main-study-agent-v5')
  assert.match(rendered.systemPrompt, /CourseLens/)
  assert.match(rendered.runtimeContext, /courseCode: FIT2109/)
  assert.match(rendered.runtimeContext, /week: 4/)
  assert.match(rendered.runtimeContext, /topic: Git/)
  assert.match(rendered.userPrompt, /Explain branches\./)
  assert.doesNotMatch(renderMainStudyAgentPrompt({ query: 'Hello' }).runtimeContext, /undefined/)
})

test('Round 1 ModelPolicy selects the fast logical profile without an extra model call', () => {
  assert.equal(new DefaultModelPolicy().selectModel('main_agent'), 'fast')
  assert.equal(new DefaultModelPolicy().selectModel('research_agent'), 'strong')
})

test('StudyController validates, selects a model, injects runId, and returns the runtime result', async () => {
  const calls: { query: string; courseCode: string | undefined; profile: string | undefined }[] = []
  const result: StudyTurnResult = {
    runId: 'runtime-run',
    answer: 'Branches are movable pointers.',
    conversation: { sessionId: 'session-a', conversationId: 'session-a' },
    turnId: '1',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
    subagentsUsed: [],
    researchActions: 0,
  }
  const runtime: StudyAgentRuntime = {
    async runTurn(input, options) {
      calls.push({ query: input.query, courseCode: input.courseContext?.courseCode, profile: options?.modelProfile })
      return result
    },
  }
  let policyCalls = 0
  const controller = new StudyController(runtime, {
    selectModel(task) {
      assert.equal(task, 'main_agent')
      policyCalls += 1
      return 'fast'
    },
  }, { runIdFactory: () => 'controller-run' })

  const actual = await controller.runTurn({ query: '  Explain branches.  ', courseContext: { courseCode: 'FIT2109' } })
  assert.equal(actual.runId, 'controller-run')
  assert.equal(actual.answer, result.answer)
  assert.equal(policyCalls, 1)
  assert.deepEqual(calls, [{ query: 'Explain branches.', courseCode: 'FIT2109', profile: 'fast' }])
})

test('StudyController awaits one completed-turn observation with real turn identity', async () => {
  const sink = new InMemoryAgentEventSink()
  const sequence: string[] = []
  let observation: Record<string, unknown> | undefined
  const runtime: StudyAgentRuntime = {
    async runTurn(): Promise<StudyTurnResult> {
      sequence.push('runtime_completed')
      return {
        runId: 'runtime-run',
        answer: 'Use a commit graph.',
        conversation: { sessionId: 'session-observe', conversationId: 'session-observe' },
        turnId: '7',
        modelProfile: 'fast',
        promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
        evidence: [],
        toolsUsed: [],
        subagentsUsed: [],
        researchActions: 0,
      }
    },
  }
  const controller = new StudyController(runtime, new DefaultModelPolicy(), {
    eventSink: sink,
    runIdFactory: () => 'run-observe',
    postTurnObserver: {
      async observe(input) {
        sequence.push('observation_completed')
        observation = input as unknown as Record<string, unknown>
        return [{ operation: 'ADD' }]
      },
    },
  })

  const result = await controller.runTurn({
    query: 'I confuse reset and revert.',
    courseContext: { courseCode: 'FIT2109', week: 4, topic: 'Git' },
  })

  assert.equal(result.answer, 'Use a commit graph.')
  assert.deepEqual(sequence, ['runtime_completed', 'observation_completed'])
  assert.deepEqual(observation, {
    userMessage: 'I confuse reset and revert.',
    assistantResponse: 'Use a commit graph.',
    sourceSessionId: 'session-observe',
    sourceTurnId: 'run-observe',
    runId: 'run-observe',
    conversationId: 'session-observe',
    turnId: '7',
    course: 'FIT2109',
    topic: 'Git',
    week: 4,
  })
  assert.deepEqual(sink.events.map((event) => event.type), [
    'run_started',
    'memory_observation_started',
    'memory_observation_completed',
    'run_completed',
  ])
  assert.equal(sink.events[2]?.resultCount, 1)
})

test('Post-turn observation failure is non-fatal and emits a safe lifecycle event', async () => {
  const sink = new InMemoryAgentEventSink()
  const result: StudyTurnResult = {
    runId: 'runtime-run',
    answer: 'Successful answer.',
    conversation: { sessionId: 'session-a', conversationId: 'session-a' },
    turnId: '2',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
    subagentsUsed: [],
    researchActions: 0,
  }
  const controller = new StudyController(
    { async runTurn() { return result } },
    new DefaultModelPolicy(),
    {
      eventSink: sink,
      runIdFactory: () => 'run-observation-failure',
      postTurnObserver: { async observe() { throw new Error('secret provider detail') } },
    },
  )

  const actual = await controller.runTurn({ query: 'Question' })
  assert.equal(actual.answer, 'Successful answer.')
  assert.deepEqual(sink.events.map((event) => event.type), [
    'run_started',
    'memory_observation_started',
    'memory_observation_failed',
    'run_completed',
  ])
  assert.equal(sink.events[2]?.errorCode, 'MEMORY_OBSERVATION_FAILED')
  assert.equal(sink.events.some((event) => event.type === 'run_failed'), false)
  assert.equal(JSON.stringify(sink.events).includes('secret provider detail'), false)
})
