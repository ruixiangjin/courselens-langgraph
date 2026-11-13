import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { StudyRuntimeError, type ModelProfile } from '@monash-study/study-core'

export type StudyChatModel = (
  messages: BaseMessage[],
  profile: ModelProfile,
  signal?: AbortSignal,
) => Promise<AIMessage>

export const configuredStudyModel: StudyChatModel = (messages, profile, signal) => {
  const { STUDY_MODEL_API_KEY, STUDY_MODEL_BASE_URL, STUDY_MODEL, STUDY_RESEARCH_MODEL } = process.env
  const model = profile === 'strong' ? STUDY_RESEARCH_MODEL || STUDY_MODEL : STUDY_MODEL
  if (!STUDY_MODEL_API_KEY || !STUDY_MODEL_BASE_URL || !model) {
    throw new StudyRuntimeError('MODEL_ERROR', 'Configure STUDY_MODEL_API_KEY, STUDY_MODEL_BASE_URL and STUDY_MODEL.')
  }
  return new ChatOpenAI({
    model,
    apiKey: STUDY_MODEL_API_KEY,
    configuration: { baseURL: STUDY_MODEL_BASE_URL },
    useResponsesApi: false,
    maxRetries: 0,
    timeout: 45_000,
  }).invoke(messages, signal === undefined ? {} : { signal })
}
