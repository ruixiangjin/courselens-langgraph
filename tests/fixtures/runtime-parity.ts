import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { StudyChatModel } from '@monash-study/langgraph-runtime'
import type { Evidence } from '@monash-study/shared-types'
import type { KnowledgeService } from '@monash-study/study-core'

export const studyQuestion = {
  query: 'Compare the backup schedule with the recovery objective.',
  courseContext: { courseCode: 'DEMO' },
}

export const continuityMarker = 'ORANGE-731'
export const continuityQuestions = [
  `The marker for this conversation is ${continuityMarker}.`,
  'What marker did I give you earlier?',
] as const

export const completedTurnEvents = [
  'run_started',
  'model_started',
  'model_completed',
  'answer_completed',
  'run_completed',
] as const

export const fixtureEvidence: Evidence = {
  evidenceId: 'backup-schedule',
  title: 'Backup and recovery',
  content: 'Daily backups and a four-hour recovery objective.',
  course: 'DEMO',
  sourceSystem: 'local',
  retrievalProvider: 'local',
  metadata: {},
}

export const fixtureKnowledge: KnowledgeService = {
  async search({ course }) {
    return course === 'DEMO' ? [fixtureEvidence] : []
  },
}

export type FixtureScenario = 'research' | 'tools' | 'memory' | 'continuity'

export function fixtureModel(scenario?: FixtureScenario): StudyChatModel {
  return async (messages, profile, _signal, tools) => {
    if (scenario === 'continuity') {
      return new AIMessage(messages.some(message =>
        message.type === 'human' && message.text.includes(continuityMarker),
      ) ? continuityMarker : 'No marker was supplied.')
    }
    const last = messages.at(-1)
    if (scenario === 'research' && profile === 'strong' && last?.type === 'tool') {
      const task = messages.find(message => message.type === 'human')?.text.split('\n')[1] ?? '{}'
      const { taskId } = JSON.parse(task) as { taskId?: string }
      return new AIMessage(JSON.stringify({
        taskId, summary: fixtureEvidence.content,
        findings: [{ content: fixtureEvidence.content, evidenceIds: [fixtureEvidence.evidenceId] }],
        evidenceIds: [fixtureEvidence.evidenceId], limitations: [],
      }))
    }
    if (last?.type === 'tool') return new AIMessage(last.text)
    if (scenario === 'memory') return callTool('recall_memory', { query: 'study preferences' }, messages)
    if (scenario === 'research' && profile === 'fast') {
      return callTool('research_subagent', { objective: studyQuestion.query }, messages)
    }
    if (tools?.some(tool => tool.name === 'search_knowledge')) {
      return callTool('search_knowledge', { query: 'backup and recovery' }, messages)
    }
    return new AIMessage('The study graph completed the turn.')
  }
}

function callTool(name: string, args: Record<string, string>, messages: BaseMessage[]) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id: `${name}-${messages.length}` }] })
}
