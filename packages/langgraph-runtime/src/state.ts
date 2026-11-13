import { MessagesValue, StateSchema } from '@langchain/langgraph'

export const StudyGraphState = new StateSchema({ messages: MessagesValue })
