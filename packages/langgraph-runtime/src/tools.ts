import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  executeKnowledgeTool,
  recallStudyMemory,
  type StudyAgentToolServices,
  type StudyTurnInput,
} from '@monash-study/study-core'
import type { Evidence } from '@monash-study/shared-types'

export function knowledgeTools(
  services: StudyAgentToolServices,
  input: StudyTurnInput,
  evidence: Map<string, Evidence>,
  recordAction: (name: string) => void,
) {
  const course = input.courseContext?.courseCode
  if (course === undefined) return []
  return [
    ...(services.knowledgeService === undefined ? [] : [
      tool(async ({ query, limit }, config) => {
        recordAction('search_knowledge')
        return JSON.stringify(await executeKnowledgeTool(
          'search_knowledge', { query, limit, course, week: input.courseContext?.week },
          services, input, evidence, config?.signal,
        ))
      }, {
        name: 'search_knowledge',
        description: 'Search the current course and return cited evidence.',
        schema: z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(12).optional() }),
      }),
    ]),
    ...(services.resourceReader === undefined ? [] : [
      tool(async ({ resourceId }, config) => {
        if (![...evidence.values()].some(item => item.resourceId === resourceId)) {
          throw new Error('Search the current course to find this resource first')
        }
        recordAction('get_resource')
        const result = await executeKnowledgeTool(
          'get_resource', { resourceId }, services, input, evidence, config?.signal, course,
        ) as { resource: unknown; content: string }
        return JSON.stringify({ ...result, content: result.content.slice(0, 12_000) })
      }, {
        name: 'get_resource',
        description: 'Read a text resource identified by a current search result.',
        schema: z.object({ resourceId: z.string().trim().min(1) }),
      }),
    ]),
  ]
}

export function createMemoryRecallTool(services: StudyAgentToolServices, input: StudyTurnInput, recordAction: (name: string) => void) {
  const reader = services.memoryReader
  if (reader === undefined) return undefined
  const course = input.courseContext?.courseCode
  const topic = input.courseContext?.topic
  return tool(async ({ query }) => {
    recordAction('recall_memory')
    return JSON.stringify(await recallStudyMemory(reader, {
      query, limit: 4,
      ...(course === undefined ? {} : { course }),
      ...(topic === undefined ? {} : { topic }),
    }))
  }, {
    name: 'recall_memory',
    description: 'Recall relevant study preferences and learning context.',
    schema: z.object({ query: z.string().trim().min(1) }),
  })
}
