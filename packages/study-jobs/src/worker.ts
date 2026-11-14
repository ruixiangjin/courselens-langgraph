import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { StudyTurnResult } from '@monash-study/study-core'

type Plan = NonNullable<StudyTurnResult['plan']>

export async function runStudyJob(pool: Pool, buildCards: (plan: Plan) => Promise<unknown>) {
  const lease = randomUUID()
  await pool.query(`
    UPDATE courselens.study_jobs SET status='dead', error='lease_expired',lease=NULL,lease_until=NULL
    WHERE status='running' AND lease_until<=now() AND attempts>=3
  `)
  const { rows } = await pool.query<{ id: string; payload: Plan }>(`
    WITH next AS (
      SELECT id FROM courselens.study_jobs
      WHERE attempts<3 AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<=now()))
      ORDER BY run_after,id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE courselens.study_jobs AS job SET status='running',attempts=attempts+1,lease=$1,
      lease_until=now()+interval '60 seconds' FROM next WHERE job.id=next.id RETURNING job.id,job.payload
  `, [lease])
  const job = rows[0]
  if (!job) return false
  try {
    const result = await buildCards(job.payload)
    await pool.query(`
      UPDATE courselens.study_jobs SET status='done',result=$3,error=NULL,lease=NULL,lease_until=NULL
      WHERE id=$1 AND lease=$2 AND lease_until>now()
    `, [job.id, lease, JSON.stringify(result)])
  } catch {
    await pool.query(`
      UPDATE courselens.study_jobs SET status=CASE WHEN attempts>=3 THEN 'dead' ELSE 'queued' END,
      error='card_generation_failed',run_after=now()+attempts*interval '2 seconds',lease=NULL,lease_until=NULL
      WHERE id=$1 AND lease=$2 AND lease_until>now()
    `, [job.id, lease])
  }
  return true
}
