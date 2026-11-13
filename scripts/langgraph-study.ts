import { parseArgs } from 'node:util'

import { AIMessage } from '@langchain/core/messages'
import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { LangGraphStudyRuntime } from '@monash-study/langgraph-runtime'
import { createStudyApplication } from '@monash-study/study-application'

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: { course: { type: 'string' }, query: { type: 'string' }, fixture: { type: 'boolean' } },
})

if (!values.query) throw new Error('Usage: pnpm agent:graph -- --course DEMO --query "Question" [--fixture]')

const runtimeConfig = loadRuntimeConfig()
if (!values.fixture) loadApplicationEnvironment(runtimeConfig.applicationRoot)
const application = await createStudyApplication({
  runtimeConfig,
  knowledgeService: null,
  resourceReader: null,
  memoryService: null,
  runtimeFactory: () => new LangGraphStudyRuntime(values.fixture
    ? { model: async () => new AIMessage('The study graph completed the turn.') }
    : {}),
})

try {
  const result = await application.runTurn({
    query: values.query,
    ...(values.course === undefined ? {} : { courseContext: { courseCode: values.course } }),
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await application.close()
}
