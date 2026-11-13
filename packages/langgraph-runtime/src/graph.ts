import { AIMessage, SystemMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { toStudyRuntimeError, type ModelProfile } from '@monash-study/study-core'

import type { StudyChatModel } from './model.js'
import { StudyGraphState } from './state.js'

const MAX_MODEL_STEPS = 8

export function createStudyGraph(input: {
  readonly model: StudyChatModel
  readonly profile: ModelProfile
  readonly systemPrompt: string
  readonly tools: StructuredToolInterface[]
  readonly checkpointer: BaseCheckpointSaver | false
  readonly maxModelSteps?: number
}) {
  const maxModelSteps = input.maxModelSteps ?? MAX_MODEL_STEPS
  const tools = new ToolNode(input.tools)
  let steps = 0
  return new StateGraph(StudyGraphState)
    .addNode('model', async (state, config) => {
      steps += 1
      const availableTools = steps < maxModelSteps ? input.tools : []
      const message = await input.model(
        [new SystemMessage(input.systemPrompt), ...state.messages],
        input.profile,
        config.signal,
        availableTools,
      )
      if (message.invalid_tool_calls?.length || (message.tool_calls?.length && availableTools.length === 0)) {
        throw toStudyRuntimeError(undefined, 'MODEL_ERROR')
      }
      return { messages: [message] }
    })
    .addNode('tools', async (state, config) => {
      const last = state.messages.at(-1)
      const messages = []
      for (const call of AIMessage.isInstance(last) ? last.tool_calls ?? [] : []) {
        config.signal?.throwIfAborted()
        const result = await tools.invoke([new AIMessage({ content: '', tool_calls: [call] })], config)
        messages.push(...result)
      }
      return { messages }
    })
    .addEdge(START, 'model')
    .addConditionalEdges('model', state => {
      const last = state.messages.at(-1)
      return steps < maxModelSteps && AIMessage.isInstance(last) && last.tool_calls?.length ? 'tools' : END
    }, ['tools', END])
    .addEdge('tools', 'model')
    .compile({ checkpointer: input.checkpointer })
}
