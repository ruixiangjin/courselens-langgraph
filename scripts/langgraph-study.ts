import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'

import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { createStudyPersistence } from '@monash-study/langgraph-runtime'
import { createStudyApplication } from '@monash-study/study-application'
import type { StudyTurnResult } from '@monash-study/study-core'
import {
  continuityMarker,
  continuityQuestions,
  fixtureKnowledge,
  fixtureModel,
  studyQuestion,
  type FixtureScenario,
} from '../tests/fixtures/runtime-parity.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    course: { type: 'string' },
    query: { type: 'string' },
    fixture: { type: 'boolean' },
    scenario: { type: 'string' },
    session: { type: 'string' },
    persist: { type: 'boolean' },
  },
})

const scenario = values.scenario as FixtureScenario | undefined
if (scenario !== undefined && (!values.fixture || !['continuity', 'memory', 'tools', 'research'].includes(scenario))) {
  throw new Error('Use --fixture with a supported scenario: continuity, memory, tools or research.')
}
if (values.session && !values.persist) throw new Error('Use --persist when continuing a session.')

const runtimeConfig = loadRuntimeConfig()
if (!values.fixture || values.persist) loadApplicationEnvironment(runtimeConfig.applicationRoot)
const databaseUrl = process.env.STUDY_CHECKPOINT_DATABASE_URL
if (values.persist && !databaseUrl) throw new Error('Set STUDY_CHECKPOINT_DATABASE_URL and run pnpm checkpoint:init.')

if (scenario === 'continuity' && values.query === undefined) {
  if (!values.persist) throw new Error('Use --persist to run the cross-process continuity scenario.')
  await verifyContinuity()
} else {
  await runTurn()
}

async function runTurn(): Promise<void> {
  const query = values.query ?? (values.fixture ? studyQuestion.query : undefined)
  if (!query) throw new Error('Usage: pnpm agent:graph -- --course FIT2109 --query "Question"')
  const course = values.course ?? (values.fixture ? studyQuestion.courseContext.courseCode : undefined)
  const persistence = values.persist && databaseUrl ? createStudyPersistence(databaseUrl) : undefined
  try {
    const application = await createStudyApplication({
      runtimeConfig,
      ...(values.fixture ? {
        model: fixtureModel(scenario),
        knowledgeService: fixtureKnowledge,
        resourceReader: null,
        memoryService: null,
        ...(scenario === 'memory' ? { memoryReader: { async recall() { return [] } } } : {}),
      } : {}),
      ...(persistence === undefined ? {} : { checkpointer: persistence.checkpointer, sessions: persistence.sessions }),
    })
    try {
      const result = await application.runTurn({
        query,
        ...(values.session === undefined ? {} : {
          conversation: { sessionId: values.session, conversationId: values.session },
        }),
        ...(course === undefined ? {} : { courseContext: { courseCode: course } }),
      })
      console.log(JSON.stringify(result, null, 2))
    } finally {
      await application.close()
    }
  } finally {
    await persistence?.close()
  }
}

async function verifyContinuity(): Promise<void> {
  const run = promisify(execFile)
  const childArgs = [
    '--import', 'tsx', 'scripts/langgraph-study.ts', '--fixture', '--scenario', 'continuity', '--persist',
  ]
  const first = await run(process.execPath, [...childArgs, '--query', continuityQuestions[0]])
  const sessionId = (JSON.parse(first.stdout) as StudyTurnResult).conversation.sessionId
  const second = await run(process.execPath, [...childArgs, '--query', continuityQuestions[1], '--session', sessionId])
  const followUp = JSON.parse(second.stdout) as StudyTurnResult
  if (followUp.answer !== continuityMarker || followUp.conversation.sessionId !== sessionId) {
    throw new Error('The second process could not continue the first session.')
  }
  console.log(JSON.stringify({ sessionId, answer: followUp.answer, continuity: 'passed' }, null, 2))
}
