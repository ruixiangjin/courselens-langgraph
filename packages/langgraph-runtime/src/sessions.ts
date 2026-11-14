import { Pool } from 'pg'
import { StudyRuntimeError } from '@monash-study/study-core'

interface SessionRequest {
  readonly id: string
  readonly course: string | null
  readonly existing: boolean
  readonly allowCreate?: boolean
}

export interface StudySessions {
  run<T>(session: SessionRequest, execute: () => Promise<T>): Promise<T>
}

export function createMemorySessions(): StudySessions {
  const scopes = new Map<string, string | null>()
  return {
    async run(session, execute) {
      if (session.existing && !(session.allowCreate && !scopes.has(session.id))) {
        assertScope(scopes.has(session.id), scopes.get(session.id), session)
      } else {
        scopes.set(session.id, session.course)
      }
      return execute()
    },
  }
}

export class PostgresStudySessions implements StudySessions {
  readonly #pool: Pool

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  }

  async setup(): Promise<void> {
    await this.#pool.query(`
      CREATE SCHEMA IF NOT EXISTS courselens;
      CREATE TABLE IF NOT EXISTS courselens.graph_sessions (
        session_id text PRIMARY KEY,
        course text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `)
  }

  async run<T>(session: SessionRequest, execute: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    let locked = false
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('courselens:' || $1::text, 0)) AS locked",
        [session.id],
      )
      locked = lock.rows[0]?.locked === true
      if (!locked) throw new StudyRuntimeError('CONCURRENT_RUN', 'This study session already has an active turn.')
      if (session.allowCreate) {
        await client.query(
          'INSERT INTO courselens.graph_sessions (session_id, course) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [session.id, session.course],
        )
      }
      if (session.existing) {
        const { rows } = await client.query<{ course: string | null }>(
          'SELECT course FROM courselens.graph_sessions WHERE session_id = $1',
          [session.id],
        )
        assertScope(rows.length > 0, rows[0]?.course, session)
      } else {
        await client.query(
          'INSERT INTO courselens.graph_sessions (session_id, course) VALUES ($1, $2)',
          [session.id, session.course],
        )
      }
      return await execute()
    } finally {
      try {
        if (locked) {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('courselens:' || $1::text, 0))",
            [session.id],
          )
        }
      } catch (error) {
        client.release(error instanceof Error ? error : true)
        throw error
      }
      client.release()
    }
  }

  close(): Promise<void> {
    return this.#pool.end()
  }
}

function assertScope(exists: boolean, course: string | null | undefined, session: SessionRequest): void {
  if (!exists || course !== session.course) {
    throw new StudyRuntimeError('SESSION_ERROR', 'This study session is unavailable for the selected course.')
  }
}
