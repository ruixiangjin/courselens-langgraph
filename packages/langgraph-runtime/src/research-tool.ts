import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  failedResearchResult,
  RESEARCH_SUBAGENT_NAME,
  RESEARCH_SUBAGENT_TOOL_NAME,
  type AgentEvent,
  type ResearchTask,
  type StudyAgentToolServices,
  type StudyTurnInput,
} from '@monash-study/study-core'
import type { Evidence } from '@monash-study/shared-types'

import { researchCourse } from './research-graph.js'
import type { StudyChatModel } from './model.js'
import { knowledgeTools } from './tools.js'

export function createResearchTool(input: {
  readonly turn: StudyTurnInput
  readonly services: StudyAgentToolServices
  readonly model: StudyChatModel
  readonly evidence: Map<string, Evidence>
  readonly recordAction: (name: string) => void
  readonly emit: (type: AgentEvent['type'], details?: Partial<AgentEvent>) => Promise<void>
}) {
  const context = input.turn.courseContext
  if (context === undefined || input.services.knowledgeService === undefined) return undefined

  let tasks = 0
  return tool(async ({ objective }, config) => {
    if (tasks >= 2) throw new Error('Research delegation budget exhausted')
    tasks += 1
    const task: ResearchTask = {
      taskId: config?.toolCall?.id || `research-${tasks}`,
      objective,
      course: context.courseCode,
      ...(context.week === undefined ? {} : { week: context.week }),
      ...(context.topic === undefined ? {} : { topic: context.topic }),
    }
    const details = { taskId: task.taskId, subagentName: RESEARCH_SUBAGENT_NAME }
    input.recordAction(RESEARCH_SUBAGENT_TOOL_NAME)
    await input.emit('subagent_started', details)
    const evidence = new Map<string, Evidence>()
    try {
      const result = await researchCourse({
        task,
        model: input.model,
        tools: knowledgeTools(input.services, input.turn, evidence, input.recordAction),
        evidence,
        ...(config?.signal === undefined ? {} : { signal: config.signal }),
      })
      for (const item of evidence.values()) input.evidence.set(item.evidenceId, item)
      await input.emit('subagent_completed', { ...details, evidenceCount: result.evidenceIds.length })
      return JSON.stringify(result)
    } catch {
      config?.signal?.throwIfAborted()
      await input.emit('subagent_failed', { ...details, errorCode: 'SUBAGENT_FAILED' })
      return JSON.stringify(failedResearchResult(task, 'Research was unavailable for this task.'))
    }
  }, {
    name: RESEARCH_SUBAGENT_TOOL_NAME,
    description: 'Delegate multi-step research within the current course. Supply a precise objective.',
    schema: z.object({ objective: z.string().trim().min(1) }),
  })
}
