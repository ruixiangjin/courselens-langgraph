import { HumanMessage } from '@langchain/core/messages'
import {
  RESEARCH_SUBAGENT_SYSTEM_PROMPT,
  parseResearchResultText,
  renderResearchTaskPrompt,
  type ResearchTask,
} from '@monash-study/study-core'
import type { Evidence } from '@monash-study/shared-types'

import { createStudyGraph } from './graph.js'
import type { StudyChatModel } from './model.js'
import type { knowledgeTools } from './tools.js'

export async function researchCourse(input: {
  readonly task: ResearchTask
  readonly model: StudyChatModel
  readonly tools: ReturnType<typeof knowledgeTools>
  readonly evidence: Map<string, Evidence>
  readonly signal?: AbortSignal
}) {
  const graph = createStudyGraph({
    model: input.model,
    profile: 'strong',
    systemPrompt: RESEARCH_SUBAGENT_SYSTEM_PROMPT,
    tools: input.tools,
    checkpointer: false,
    maxModelSteps: 4,
  })
  const state = await graph.invoke({
    messages: [new HumanMessage(renderResearchTaskPrompt(input.task))],
  }, input.signal === undefined ? {} : { signal: input.signal })
  const result = parseResearchResultText(
    state.messages.at(-1)?.text ?? '', input.task, new Set(input.evidence.keys()),
  )
  const findings = result.findings.filter(finding => finding.evidenceIds.length > 0)
  return {
    ...result,
    findings,
    limitations: findings.length === result.findings.length
      ? result.limitations
      : [...result.limitations, 'Some findings lacked supporting citations.'],
  }
}
