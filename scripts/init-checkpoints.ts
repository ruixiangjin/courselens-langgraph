import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { createStudyPersistence } from '@monash-study/langgraph-runtime'

loadApplicationEnvironment(loadRuntimeConfig().applicationRoot)
const connectionString = process.env.STUDY_CHECKPOINT_DATABASE_URL
if (!connectionString) throw new Error('Set STUDY_CHECKPOINT_DATABASE_URL to initialize checkpoints.')

const persistence = createStudyPersistence(connectionString)
try {
  await persistence.setup()
  console.log('Study checkpoints and sessions are ready.')
} finally {
  await persistence.close()
}
