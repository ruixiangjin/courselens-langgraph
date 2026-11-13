import { randomUUID } from 'node:crypto'

import { HumanMessage } from '@langchain/core/messages'
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph'
import {
  MAIN_STUDY_AGENT_PROMPT_VERSION,
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
import { createResearchTool } from './research-tool.js'
import { knowledgeTools } from './tools.js'

export interface LangGraphStudyRuntimeOptions {
  readonly services?: StudyAgentToolServices
  readonly model?: StudyChatModel
  readonly checkpointer?: BaseCheckpointSaver
}

export class LangGraphStudyRuntime implements StudyAgentRuntime {
  readonly #services: StudyAgentToolServices
  readonly #model: StudyChatModel
  readonly #checkpointer: BaseCheckpointSaver

  constructor(options: LangGraphStudyRuntimeOptions = {}) {
    this.#services = options.services ?? {}
    this.#model = options.model ?? configuredStudyModel
    this.#checkpointer = options.checkpointer ?? new MemorySaver()
  }

  async runTurn(input: StudyTurnInput, options: StudyTurnOptions = {}): Promise<StudyTurnResult> {
    const runId = options.runId ?? randomUUID()
    const modelProfile = options.modelProfile ?? 'fast'
    const sessionId = input.conversation?.sessionId ?? randomUUID()
    const conversation = input.conversation ?? { sessionId, conversationId: sessionId }
    const turnId = randomUUID()
    const emit = async (type: AgentEventType, details: Partial<AgentEvent> = {}) => options.eventSink?.emit({
      type, runId, sessionId, conversationId: conversation.conversationId, turnId, modelProfile,
      timestamp: new Date().toISOString(), ...details,
    })

    try {
      options.signal?.throwIfAborted()
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
      const tools = [
        ...knowledgeTools(this.#services, input, evidence, recordAction),
        ...(research === undefined ? [] : [research]),
      ]
      const prompt = renderMainStudyAgentPrompt(input, { toolsEnabled: tools.length > 0 })
      const graph = createStudyGraph({
        model: this.#model,
        tools,
        profile: modelProfile,
        systemPrompt: research === undefined ? prompt.systemPrompt : [
          prompt.systemPrompt,
          'For research_subagent, send the objective field. The runtime supplies the task identity and course.',
        ].join('\n'),
        checkpointer: this.#checkpointer,
      })
      await emit('model_started')
      const result = await graph.invoke({ messages: [new HumanMessage(prompt.userPrompt)] }, {
        configurable: { thread_id: sessionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const message = result.messages.at(-1)
      const answer = message?.type === 'ai' ? message.text.trim() : ''
      if (!answer) throw toStudyRuntimeError(undefined, 'MODEL_ERROR')
      await emit('model_completed')
      await emit('answer_completed')
      return {
        answer, runId, conversation, turnId, modelProfile,
        promptVersion: MAIN_STUDY_AGENT_PROMPT_VERSION,
        evidence: [...evidence.values()],
        toolsUsed: [...toolsUsed],
        subagentsUsed: toolsUsed.has(RESEARCH_SUBAGENT_TOOL_NAME) ? [RESEARCH_SUBAGENT_NAME] : [],
        researchActions,
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new StudyRuntimeError('ABORTED', 'The Study Agent turn was aborted.', { cause: error })
      }
      throw toStudyRuntimeError(error, 'MODEL_ERROR')
    }
  }
}
