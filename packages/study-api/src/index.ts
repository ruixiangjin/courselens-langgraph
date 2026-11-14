import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import { z } from 'zod'
import type { StudyApplication } from '@monash-study/study-application'
import type { StudyTurnResult } from '@monash-study/study-core'
import { StudyConflict, StudyStore } from './store.js'

export interface StudyPrincipal { readonly student: string; readonly token: string; readonly role: 'student' | 'operator' }
const turnInput = z.object({
  session: z.uuid(), turn: z.uuid(), question: z.string().trim().min(1).max(4_000),
  course: z.string().regex(/^[A-Z0-9-]{2,24}$/).optional(),
})
const idInput = z.object({ id: z.uuid() })

function equalToken(supplied: string, expected: string) {
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function studentResult(result: StudyTurnResult) {
  return {
    ...result,
    evidence: result.evidence.map(({ evidenceId, title, content, sourceSystem, metadata }) => ({
      evidenceId, title, content, sourceSystem,
      sourceHash: typeof metadata.sourceHash === 'string' ? metadata.sourceHash : null,
      page: typeof metadata.page === 'number' ? metadata.page : null,
    })),
  }
}

export async function createStudyServer(input: {
  store: StudyStore; principals: readonly StudyPrincipal[]; applicationFor: (student: string) => Promise<StudyApplication>;
}) {
  const { store } = input
  const app = Fastify()
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid study request.' })
    if (error instanceof StudyConflict) return reply.code(409).send({ error: error.message })
    request.log.error({ name: error instanceof Error ? error.name : 'Error' }, 'Study request failed')
    return reply.code(500).send({ error: 'Study request failed.' })
  })
  for (const [route, filename, type] of [
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
  ] as const) {
    const contents = await readFile(new URL('../public/' + filename, import.meta.url))
    app.get(route, async (_request, reply) => reply.header('content-security-policy', "default-src 'self'; frame-ancestors 'none'").type(type).send(contents))
  }
  app.get('/healthz', async () => { await store.pool.query('SELECT 1'); return { ready: true } })
  await app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token || !input.principals.some(principal => equalToken(token, principal.token))) {
        return reply.code(401).send({ error: 'Sign in with a study access token.' })
      }
    })
    function principal(authorization: string | undefined) {
      const token = authorization?.match(/^Bearer (\S+)$/i)?.[1] ?? ''
      return input.principals.find(item => equalToken(token, item.token))!
    }
    api.get('/trace', async (request, reply) => {
      if (principal(request.headers.authorization).role !== 'operator') return reply.code(403).send({ error: 'Operator access required.' })
      return store.operatorTraces()
    })
    api.post('/turns', async (request, reply) => {
      const actor = principal(request.headers.authorization)
      if (actor.role !== 'student') return reply.code(403).send({ error: 'Student access required.' })
      const turn = turnInput.parse(request.body)
      if (!await store.session(turn.session, actor.student, turn.course ?? null)) {
        return reply.code(404).send({ error: 'Study session was not found.' })
      }
      return store.withSession(turn.session, async () => {
        const previous = await store.beginTurn(turn.turn, actor.student, turn.session, turn.question)
        if (previous) return studentResult(previous)
        try {
          const application = await input.applicationFor(actor.student)
          const result = await application.runTurn({
            query: turn.question,
            ...(turn.course ? { courseContext: { courseCode: turn.course } } : {}),
            conversation: { sessionId: turn.session, conversationId: turn.session },
          }, { runId: turn.turn, allowCreateSession: true, signal: AbortSignal.timeout(120_000), eventSink: { emit: event => store.trace(turn.turn, event) } })
          await store.finishTurn(turn.turn, result)
          return studentResult(result)
        } catch (error) {
          await store.finishTurn(turn.turn, null)
          throw error
        }
      })
    })
    api.get('/turns/:id/events', async (request, reply) => {
      const id = idInput.parse(request.params).id
      const actor = principal(request.headers.authorization)
      const last = z.coerce.number().int().nonnegative().safeParse(request.headers['last-event-id'] ?? 0)
      if (!last.success) return reply.code(400).send({ error: 'Invalid event cursor.' })
      const owned = await store.getTurn(id, actor.student)
      if (!owned) return reply.code(404).send({ error: 'Study turn was not found.' })
      async function* events() {
        let cursor = last.data
        const deadline = Date.now() + 125_000
        while (!reply.raw.destroyed && Date.now() < deadline) {
          const current = await store.getTurn(id, actor.student)
          const { rows } = await store.pool.query<{ seq: string; event: unknown }>(
            'SELECT seq,event FROM courselens.turn_events WHERE turn=$1 AND seq>$2 ORDER BY seq LIMIT 100', [id, cursor],
          )
          for (const { seq, event } of rows) {
            cursor = Number(seq)
            yield 'id: ' + seq + '\ndata: ' + JSON.stringify(event) + '\n\n'
          }
          if (rows.length === 100) continue
          if (current?.status !== 'running') return
          if (!rows.length) yield ': waiting\n\n'
          await delay(300)
        }
      }
      return reply.header('cache-control', 'no-store').type('text/event-stream').send(Readable.from(events()))
    })
    api.post('/jobs/:id/retry', async (request, reply) => {
      if (principal(request.headers.authorization).role !== 'operator') return reply.code(403).send({ error: 'Operator access required.' })
      const id = idInput.parse(request.params).id
      const { rowCount } = await store.pool.query(
        "UPDATE courselens.study_jobs SET status='queued',attempts=0,run_after=now(),error=NULL WHERE id=$1 AND status='dead'", [id],
      )
      if (!rowCount) return reply.code(409).send({ error: 'The job is not in the dead-letter state.' })
      return reply.code(202).send({ status: 'queued' })
    })
    api.post('/turns/:id/approve', async (request, reply) => {
      const id = idInput.parse(request.params).id
      const actor = principal(request.headers.authorization)
      const turn = await store.getTurn(id, actor.student)
      if (actor.role !== 'student' || !turn?.result?.plan) return reply.code(404).send({ error: 'Study plan was not found.' })
      return reply.code(202).send(await store.queueCards(id, actor.student, turn.result.plan))
    })
    api.get('/jobs/:id', async (request, reply) => {
      const id = idInput.parse(request.params).id
      const job = await store.job(id, principal(request.headers.authorization).student)
      return job ?? reply.code(404).send({ error: 'Study job was not found.' })
    })
  }, { prefix: '/api' })
  return app
}
