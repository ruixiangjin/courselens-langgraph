import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { PostgresStudySessions } from './sessions.js'

export function createStudyPersistence(connectionString: string) {
  const checkpointer = PostgresSaver.fromConnString(connectionString)
  const sessions = new PostgresStudySessions(connectionString)
  return {
    checkpointer,
    sessions,
    async setup() {
      await checkpointer.setup()
      await sessions.setup()
    },
    async close() {
      await Promise.all([checkpointer.end(), sessions.close()])
    },
  }
}
