import { randomUUID } from 'node:crypto'

import { HumanMessage } from '@langchain/core/messages'
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph'
import {
  RESEARCH_SUBAGENT_ACTION_BUDGET,
  RESEARCH_SUBAGENT_NAME,
  RESEARCH_SUBAGENT_TOOL_NAME,
  type AgentEvent,
  StudyRuntimeError,
  renderMainStudyAgentPrompt,
  toStudyRuntimeError,
  type AgentEventType,
  type StudyAgentRuntime,
  type StudyAgentToolServices,
  type StudyTurnInput,
  type StudyTurnOptions,
  type StudyTurnResult,
} from '@monash-study/study-core'

import type { Evidence } from '@monash-study/shared-types'

import { createStudyGraph } from './graph.js'
import { configuredStudyModel, type StudyChatModel } from './model.js'
import { createStudySupervisor } from './supervisor.js'
import { createResearchTool } from './research-tool.js'
import { createMemorySessions, type StudySessions } from './sessions.js'
import { createMemoryRecallTool, knowledgeTools } from './tools.js'

export interface LangGraphStudyRuntimeOptions {
  readonly mode?: 'supervisor' | 'legacy'
  readonly sessions?: StudySessions
  readonly services?: StudyAgentToolServices
  readonly model?: StudyChatModel
  readonly checkpointer?: BaseCheckpointSaver
}

export class LangGraphStudyRuntime implements StudyAgentRuntime {
  readonly #mode: 'supervisor' | 'legacy'
  readonly #sessions: StudySessions
  readonly #services: StudyAgentToolServices
  readonly #model: StudyChatModel
  readonly #checkpointer: BaseCheckpointSaver

  constructor(options: LangGraphStudyRuntimeOptions = {}) {
    this.#mode = options.mode ?? 'supervisor'
    this.#sessions = options.sessions ?? createMemorySessions()
    this.#services = options.services ?? {}
    this.#model = options.model ?? configuredStudyModel
    this.#checkpointer = options.checkpointer ?? new MemorySaver()
  }

  async runTurn(input: StudyTurnInput, options: StudyTurnOptions = {}): Promise<StudyTurnResult> {
    const runId = options.runId ?? randomUUID()
    const modelProfile = options.modelProfile ?? 'fast'
    const sessionId = input.conversation?.sessionId ?? randomUUID()
    const conversation = input.conversation ?? { sessionId, conversationId: sessionId }
    if (conversation.conversationId !== sessionId) {
      throw toStudyRuntimeError(undefined, 'SESSION_ERROR')
    }
    const turnId = randomUUID()
    const emit = async (type: AgentEventType, details: Partial<AgentEvent> = {}) => options.eventSink?.emit({
      type, runId, sessionId, conversationId: conversation.conversationId, turnId, modelProfile,
      timestamp: new Date().toISOString(), ...details,
    })

    try {
      options.signal?.throwIfAborted()
      if (this.#mode === 'supervisor') {
        const graph = createStudySupervisor({
          turn: input, services: this.#services, model: this.#model, profile: modelProfile,
          checkpointer: this.#checkpointer, emit,
        })
        await emit('model_started')
        const state = await this.#sessions.run({
          id: sessionId, course: input.courseContext?.courseCode ?? null, existing: input.conversation !== undefined,
        }, () => graph.invoke({
          messages: [new HumanMessage(input.query)],
          intent: null, research: null, plan: null, draft: null, review: null, revision: 0, answer: '',
        }, {
          configurable: { thread_id: `study-supervisor-v1:${sessionId}` },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }))
        await emit('model_completed')
        await emit('answer_completed')
        const published = state.answer === state.draft?.answer
        const cited = new Set(published ? state.draft?.evidenceIds : [])
        return {
          answer: state.answer, runId, conversation, turnId, modelProfile,
          promptVersion: 'study-supervisor-v1',
          evidence: state.research?.evidence.filter(item => cited.has(item.evidenceId)) ?? [],
          toolsUsed: state.research?.tools ?? [],
          subagentsUsed: state.research?.actions ? ['research'] : [],
          researchActions: state.research?.actions ?? 0,
          ...(!published || !state.plan ? {} : { plan: state.plan }),
        }
      }
      const evidence = new Map<string, Evidence>()
      const toolsUsed = new Set<string>()
      let researchActions = 0
      const recordAction = (name: string) => {
        if (name === 'search_knowledge' || name === 'get_resource') {
          if (researchActions >= RESEARCH_SUBAGENT_ACTION_BUDGET) {
            throw new Error('Research retrieval action budget exhausted')
          }
          researchActions += 1
        }
        toolsUsed.add(name)
      }
      const research = createResearchTool({
        turn: input, model: this.#model, services: this.#services, evidence, recordAction, emit,
      })
      const recall = createMemoryRecallTool(this.#services, input, recordAction)
      const tools = [
        ...knowledgeTools(this.#services, input, evidence, recordAction),
        ...(recall === undefined ? [] : [recall]),
        ...(research === undefined ? [] : [research]),
      ]
      const prompt = renderMainStudyAgentPrompt(input)
      const graph = createStudyGraph({
        model: this.#model,
        tools,
        profile: modelProfile,
        systemPrompt: [
          'You are CourseLens. Explain the current course clearly and use the student context to adapt your answer.',
          'Use the available knowledge tools to ground course-specific answers. Cite returned evidence IDs and state gaps in the materials.',
          'Use recall_memory for study preferences or learning context when available. Treat memory as background.',
          'Delegate multi-step evidence research using research_subagent with an objective when available. Carry its limitations into your answer.',
        ].join('\n'),
        checkpointer: this.#checkpointer,
      })
      await emit('model_started')
      const result = await this.#sessions.run({
        id: sessionId, course: input.courseContext?.courseCode ?? null, existing: input.conversation !== undefined,
      }, () => graph.invoke({ messages: [new HumanMessage(prompt.userPrompt)] }, {
        configurable: { thread_id: sessionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }))
      const message = result.messages.at(-1)
      const answer = message?.type === 'ai' ? message.text.trim() : ''
      if (!answer) throw toStudyRuntimeError(undefined, 'MODEL_ERROR')
      await emit('model_completed')
      await emit('answer_completed')
      return {
        answer, runId, conversation, turnId, modelProfile,
        promptVersion: 'langgraph-study-v1',
        evidence: [...evidence.values()],
        toolsUsed: [...toolsUsed],
        subagentsUsed: toolsUsed.has(RESEARCH_SUBAGENT_TOOL_NAME) ? [RESEARCH_SUBAGENT_NAME] : [],
        researchActions,
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new StudyRuntimeError('ABORTED', 'The Study Agent turn was aborted.', { cause: error })
      }
      throw toStudyRuntimeError(error, 'RUNTIME_ERROR')
    }
  }
}
