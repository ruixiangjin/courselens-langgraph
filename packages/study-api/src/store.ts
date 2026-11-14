import { Pool } from 'pg'
import type { AgentEvent, StudyTurnResult } from '@monash-study/study-core'

export class StudyConflict extends Error {}

export class StudyStore {
  readonly pool: Pool
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 }) }

  async setup() {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS courselens;
      CREATE TABLE IF NOT EXISTS courselens.web_sessions (
        id uuid PRIMARY KEY, student text NOT NULL, course text
      );
      CREATE TABLE IF NOT EXISTS courselens.turns (
        id uuid PRIMARY KEY, student text NOT NULL, session uuid NOT NULL REFERENCES courselens.web_sessions(id),
        question text NOT NULL, status text NOT NULL, result jsonb, created_order bigserial
      );
      ALTER TABLE courselens.turns ADD COLUMN IF NOT EXISTS created_order bigserial;
      CREATE TABLE IF NOT EXISTS courselens.turn_events (
        seq bigserial PRIMARY KEY, turn uuid NOT NULL REFERENCES courselens.turns(id), event jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_events_turn_seq ON courselens.turn_events(turn, seq);
      CREATE TABLE IF NOT EXISTS courselens.study_jobs (
        id uuid PRIMARY KEY REFERENCES courselens.turns(id), student text NOT NULL, status text NOT NULL,
        payload jsonb NOT NULL, result jsonb, attempts integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(),
        lease uuid, lease_until timestamptz, error text
      );
    `)
  }

  async session(id: string, student: string, course: string | null) {
    await this.pool.query('INSERT INTO courselens.web_sessions VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, student, course])
    const result = await this.pool.query('SELECT 1 FROM courselens.web_sessions WHERE id=$1 AND student=$2 AND course IS NOT DISTINCT FROM $3', [id, student, course])
    return Boolean(result.rowCount)
  }

  async withSession<T>(session: string, execute: () => Promise<T>): Promise<T> {
    const connection = await this.pool.connect()
    let acquired = false
    try {
      const result = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('web:' || $1::text,0)) AS acquired", [session],
      )
      acquired = result.rows[0]?.acquired === true
      if (!acquired) throw new StudyConflict('This session already has an active turn.')
      return await execute()
    } finally {
      try {
        if (acquired) await connection.query("SELECT pg_advisory_unlock(hashtextextended('web:' || $1::text,0))", [session])
      } catch (error) {
        connection.release(error instanceof Error ? error : true)
        throw error
      }
      connection.release()
    }
  }

  async beginTurn(id: string, student: string, session: string, question: string) {
    const inserted = await this.pool.query(
      "INSERT INTO courselens.turns(id,student,session,question,status) VALUES ($1,$2,$3,$4,'running') ON CONFLICT DO NOTHING RETURNING id",
      [id, student, session, question],
    )
    if (inserted.rowCount) return undefined
    const existing = await this.pool.query<{ result: StudyTurnResult | null; status: string }>(
      'SELECT result,status FROM courselens.turns WHERE id=$1 AND student=$2 AND session=$3 AND question=$4',
      [id, student, session, question],
    )
    const previous = existing.rows[0]
    if (previous?.status === 'done' && previous.result) return previous.result
    if (!previous) throw new StudyConflict('The turn ID is already assigned to a different request.')
    const latest = await this.pool.query(
      'SELECT id FROM courselens.turns WHERE session=$1 ORDER BY created_order DESC LIMIT 1', [session],
    )
    if (latest.rows[0]?.id !== id) throw new StudyConflict('This session has a newer turn.')
    await this.pool.query("UPDATE courselens.turns SET status='running' WHERE id=$1", [id])
    return undefined
  }

  async finishTurn(id: string, result: StudyTurnResult | null) {
    await this.pool.query('UPDATE courselens.turns SET status=$2,result=$3 WHERE id=$1', [id, result ? 'done' : 'failed', result])
  }

  async trace(turn: string, event: AgentEvent) {
    const { type, timestamp, route, subagentName, taskId, errorCode, evidenceCount } = event
    await this.pool.query('INSERT INTO courselens.turn_events(turn,event) VALUES ($1,$2)', [
      turn, { type, timestamp, route, subagentName, taskId, errorCode, evidenceCount },
    ])
  }

  async getTurn(id: string, student: string) {
    const { rows } = await this.pool.query<{ status: string; result: StudyTurnResult | null }>(
      'SELECT status,result FROM courselens.turns WHERE id=$1 AND student=$2', [id, student],
    )
    return rows[0]
  }

  async operatorTraces() {
    const { rows } = await this.pool.query(
      'SELECT seq,turn,event FROM courselens.turn_events ORDER BY seq DESC LIMIT 100',
    )
    return rows
  }

  async queueCards(id: string, student: string, plan: NonNullable<StudyTurnResult['plan']>) {
    await this.pool.query(
      "INSERT INTO courselens.study_jobs(id,student,status,payload) VALUES ($1,$2,'queued',$3) ON CONFLICT DO NOTHING",
      [id, student, plan],
    )
    return this.job(id, student)
  }

  async job(id: string, student: string) {
    const { rows } = await this.pool.query(
      'SELECT id,status,attempts,result,error FROM courselens.study_jobs WHERE id=$1 AND student=$2', [id, student],
    )
    return rows[0]
  }

  async close() { await this.pool.end() }
}
