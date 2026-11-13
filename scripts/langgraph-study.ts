import { parseArgs } from 'node:util'

import { AIMessage } from '@langchain/core/messages'
import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { createStudyPersistence, LangGraphStudyRuntime } from '@monash-study/langgraph-runtime'
import { createStudyApplication } from '@monash-study/study-application'

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: { course: { type: 'string' }, query: { type: 'string' }, fixture: { type: 'boolean' }, session: { type: 'string' }, persist: { type: 'boolean' } },
})

if (!values.query) throw new Error('Usage: pnpm agent:graph -- --course DEMO --query "Question" [--fixture]')

const runtimeConfig = loadRuntimeConfig()
if (!values.fixture || values.persist) loadApplicationEnvironment(runtimeConfig.applicationRoot)
if (values.session && !values.persist) throw new Error('Use --persist when continuing a session.')
const databaseUrl = process.env.STUDY_CHECKPOINT_DATABASE_URL
if (values.persist && !databaseUrl) throw new Error('Set STUDY_CHECKPOINT_DATABASE_URL and run pnpm checkpoint:init.')
const persistence = values.persist && databaseUrl ? createStudyPersistence(databaseUrl) : undefined
const application = await createStudyApplication({
  runtimeConfig,
  knowledgeService: null,
  resourceReader: null,
  memoryService: null,
  runtimeFactory: () => new LangGraphStudyRuntime({
    ...(values.fixture ? {
      model: async messages => new AIMessage(
        messages.some(message => message.type === 'human' && message.text.includes('ORANGE-731'))
          ? 'ORANGE-731'
          : 'The study graph completed the turn.',
      ),
    } : {}),
    ...(persistence === undefined ? {} : { checkpointer: persistence.checkpointer, sessions: persistence.sessions }),
  }),
})

try {
  const result = await application.runTurn({
    query: values.query,
    ...(values.session === undefined ? {} : { conversation: { sessionId: values.session, conversationId: values.session } }),
    ...(values.course === undefined ? {} : { courseContext: { courseCode: values.course } }),
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  try {
    await application.close()
  } finally {
    await persistence?.close()
  }
}
