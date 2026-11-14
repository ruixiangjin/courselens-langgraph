import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAIN_STUDY_AGENT_PROMPT_VERSION,
  MemoryStudentContextBuilder,
  renderMainStudyAgentPrompt,
  type StudentMemoryContext,
  type StudyTurnResult,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'
import type { StudentMemory } from '@monash-study/shared-types'

const MEMORY: StudentMemory = {
  memoryId: 'memory-1',
  memoryKey: 'preference:explanation-language',
  kind: 'preference',
  scope: 'global',
  course: null,
  topic: null,
  content: 'Prefers Chinese explanations.',
  status: 'active',
  importance: 0.9,
  confidence: 1,
  sourceType: 'user_explicit',
  sourceSessionId: 'session-1',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  lastConfirmedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
}

const MEMORY_CONTEXT: StudentMemoryContext = {
  memory: MEMORY,
  direct: true,
  score: { semantic: 0, keyword: 0, importance: 0.9, confidence: 1, recency: 1, total: 1 },
}

test('StudentContextBuilder recalls current course context and prompt renders it', async () => {
  let request: Record<string, unknown> | undefined
  const builder = new MemoryStudentContextBuilder({
    async recall(input) {
      request = input
      return [MEMORY_CONTEXT]
    },
  })
  const studentContext = await builder.build({
    query: 'Explain Git branches.',
    courseContext: { courseCode: 'FIT2109', topic: 'Git' },
  })
  assert.deepEqual(request, {
    query: 'Explain Git branches.',
    course: 'FIT2109',
    topic: 'Git',
    limit: 8,
    globalLimit: 10,
  })
  const runtimePrompt = renderMainStudyAgentPrompt({
    query: 'Explain Git branches.',
    courseContext: { courseCode: 'FIT2109', topic: 'Git' },
    studentContext,
  })
  assert.match(runtimePrompt.runtimeContext, /Prefers Chinese explanations/)
})

test('StudyController injects built Student Context without coupling to MemoryService', async () => {
  let received: Record<string, unknown> | undefined
  const result: StudyTurnResult = {
    runId: 'run-1',
    answer: 'answer',
    conversation: { sessionId: 'session-1', conversationId: 'session-1' },
    turnId: '1',
    modelProfile: 'fast',
    promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
    evidence: [],
    toolsUsed: [],
    subagentsUsed: [],
    researchActions: 0,
  }
  const controller = new StudyController({
    async runTurn(input) {
      received = input as unknown as Record<string, unknown>
      return result
    },
  }, undefined, {
    runIdFactory: () => 'run-1',
    studentContextBuilder: { async build() { return { memories: [MEMORY_CONTEXT] } } },
  })
  await controller.runTurn({ query: 'Question', courseContext: { courseCode: 'FIT2109' } })
  assert.deepEqual((received?.studentContext as { memories: unknown[] }).memories, [MEMORY_CONTEXT])
})
