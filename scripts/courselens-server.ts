import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { createStudyApplication, type StudyApplication } from '@monash-study/study-application'
import { createStudyPersistence } from '@monash-study/langgraph-runtime'
import { createStudyServer, type StudyPrincipal } from '../packages/study-api/src/index.js'
import { StudyStore } from '../packages/study-api/src/store.js'
import { buildCardsOverMcp } from '../packages/study-jobs/src/mcp.js'
import { runStudyJob } from '../packages/study-jobs/src/worker.js'
import { demoKnowledge, demoModel } from '../tests/fixtures/courselens-demo.js'

const config = loadRuntimeConfig()
loadApplicationEnvironment(config.applicationRoot)
const database = process.env.STUDY_CHECKPOINT_DATABASE_URL
const studentToken = process.env.COURSELENS_STUDENT_TOKEN
const operatorToken = process.env.COURSELENS_OPERATOR_TOKEN
if (!database || !studentToken || !operatorToken || studentToken === operatorToken) {
  throw new Error('Configure a database and distinct student/operator tokens.')
}
const principals: StudyPrincipal[] = [
  { student: 'local-student', role: 'student', token: studentToken },
  { student: 'local-operator', role: 'operator', token: operatorToken },
]
const demo = process.env.COURSELENS_DEMO === '1'
const store = new StudyStore(database)
const persistence = createStudyPersistence(database)
const applications = new Map<string, Promise<StudyApplication>>()
const abort = new AbortController()
const memoryRoot = join(config.applicationRoot, 'data', 'runtime', 'student-memory')
async function applicationFor(student: string) {
  const prior = applications.get(student)
  if (prior) return prior
  const current = createStudyApplication({
    runtimeConfig: config, checkpointer: persistence.checkpointer, sessions: persistence.sessions,
    resourceReader: null,
    ...(demo ? { model: demoModel, knowledgeService: demoKnowledge, memoryService: null } : {
      memoryDatabasePath: join(memoryRoot, createHash('sha256').update(student).digest('hex') + '.sqlite'),
      initializeMemoryDatabase: true,
    }),
  })
  applications.set(student, current)
  current.catch(() => { applications.delete(student) })
  return current
}
let app: Awaited<ReturnType<typeof createStudyServer>> | undefined
let worker: Promise<void> | undefined
try {
  if (!demo) await mkdir(memoryRoot, { recursive: true })
  await persistence.setup()
  await store.setup()
  app = await createStudyServer({ store, principals, applicationFor })
  await app.listen({ host: process.env.COURSELENS_HOST ?? '127.0.0.1', port: Number(process.env.COURSELENS_PORT ?? '8080') })
  worker = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (await runStudyJob(store.pool, buildCardsOverMcp)) continue
      } catch (error) {
        app?.log.error({ error: error instanceof Error ? error.name : 'Error' }, 'Study worker failed')
      }
      await delay(400)
    }
  })()
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
} finally {
  abort.abort()
  await app?.close()
  await worker
  await Promise.allSettled([...applications.values()].map(async instance => (await instance).close()))
  await Promise.all([store.close(), persistence.close()])
}
