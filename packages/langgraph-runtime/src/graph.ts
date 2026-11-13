import { SystemMessage } from '@langchain/core/messages'
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import type { ModelProfile } from '@monash-study/study-core'

import type { StudyChatModel } from './model.js'
import { StudyGraphState } from './state.js'

export function createStudyGraph(input: {
  readonly model: StudyChatModel
  readonly profile: ModelProfile
  readonly systemPrompt: string
  readonly checkpointer: BaseCheckpointSaver
}) {
  return new StateGraph(StudyGraphState)
    .addNode('model', async (state, config) => ({
      messages: [await input.model(
        [new SystemMessage(input.systemPrompt), ...state.messages],
        input.profile,
        config.signal,
      )],
    }))
    .addEdge(START, 'model')
    .addEdge('model', END)
    .compile({ checkpointer: input.checkpointer })
}
