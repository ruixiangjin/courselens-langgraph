import { AIMessage } from '@langchain/core/messages'
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import type { Evidence } from '@monash-study/shared-types'
import {
  RESEARCH_SUBAGENT_ACTION_BUDGET, type AgentEvent, type ModelProfile, type StudyAgentToolServices,
  type StudyTurnInput,
} from '@monash-study/study-core'

import { studyHistory } from './agents/context.js'
import { studySkill } from './agents/skills.js'
import { askRole } from './agents/roles.js'
import { StudyBlackboard, studyDraft, studyPlan, understanding, verification } from './blackboard.js'
import type { StudyChatModel } from './model.js'
import { researchCourse } from './research-graph.js'
import { knowledgeTools } from './tools.js'

export function createStudySupervisor(input: {
  turn: StudyTurnInput
  services: StudyAgentToolServices
  model: StudyChatModel
  profile: ModelProfile
  checkpointer: BaseCheckpointSaver
  emit: (type: AgentEvent['type'], details?: Partial<AgentEvent>) => Promise<void>
}) {
  const { turn, model, profile, emit } = input
  const course = turn.courseContext
  const context = turn.studentContext?.memories.map(({ memory }) => memory.content)
  const base = { question: turn.query, course, context }
  return new StateGraph(StudyBlackboard)
    .addNode('understand', async (state, config) => {
      const history = studyHistory(state.messages)
      const result = await askRole(model, profile, config.signal,
        'Role: understanding. Choose intent explain for general concepts, verify_sources for course-specific claims, plan for study planning, verify_and_plan for both, or clarify for missing scope. Output {intent,objective}.',
        { ...base, history }, understanding)
      const intent = result ?? { intent: course ? 'verify_sources' as const : 'explain' as const, objective: turn.query }
      if (!course && (intent.intent === 'verify_sources' || intent.intent === 'verify_and_plan')) {
        intent.intent = 'clarify'
      }
      await emit('study_routed', { route: intent.intent })
      return { intent }
    })
    .addNode('gather_evidence', async (state, config) => {
      if (!course || !input.services.knowledgeService) {
        return { research: { evidence: [], findings: [], limitations: ['Course sources are unavailable.'], actions: 0, tools: [] } }
      }
      const previous = state.research
      const taskId = 'research-' + state.revision
      const evidence = new Map<string, Evidence>()
      const used = new Set(previous?.tools)
      let actions = previous?.actions ?? 0
      const task = {
        taskId,
        course: course.courseCode,
        objective: state.review?.reason ?? state.intent?.objective ?? turn.query,
        ...(course.week === undefined ? {} : { week: course.week }),
        ...(course.topic === undefined ? {} : { topic: course.topic }),
      }
      const tools = knowledgeTools(input.services, turn, evidence, name => {
        if (actions >= RESEARCH_SUBAGENT_ACTION_BUDGET) throw new Error('Research budget exhausted')
        actions += 1
        used.add(name)
      })
      await emit('subagent_started', { taskId, subagentName: 'research' })
      let findings = previous?.findings ?? []
      let limitations: string[]
      try {
        const result = await researchCourse({ task, model, tools, evidence, ...(config.signal ? { signal: config.signal } : {}) })
        findings = [...findings, ...result.findings.map(finding => ({ ...finding, evidenceIds: [...finding.evidenceIds] }))]
        limitations = [...result.limitations]
        await emit('subagent_completed', { taskId, subagentName: 'research', evidenceCount: evidence.size })
      } catch {
        config.signal?.throwIfAborted()
        limitations = ['Course research was temporarily unavailable.']
        await emit('subagent_failed', { taskId, subagentName: 'research', errorCode: 'SUBAGENT_FAILED' })
      }
      for (const [id, item] of evidence) {
        if (item.course !== course.courseCode) evidence.delete(id)
      }
      findings = findings.filter(finding => finding.evidenceIds.every(id => evidence.has(id) || previous?.evidence.some(item => item.evidenceId === id)))
      for (const item of previous?.evidence ?? []) {
        if (!evidence.has(item.evidenceId)) evidence.set(item.evidenceId, item)
      }
      return { research: { evidence: [...evidence.values()], findings, limitations, actions, tools: [...used] } }
    })
    .addNode('draft_plan', async (state, config) => {
      const plan = await askRole(model, profile, config.signal,
        'Role: study planner. Use the student time constraints and course evidence. Propose practice, not completed actions. Return {goal, exercises:[{activity,minutes,checkpoint}]}.',
        { ...base, findings: state.research?.findings, feedback: state.review?.reason, skill: studySkill('exam-study-plan') }, studyPlan)
      await emit('study_role_completed', { subagentName: 'planner' })
      return { plan: plan ?? null }
    })
    .addNode('tutor', async (state, config) => {
      const history = studyHistory(state.messages)
      const skill = studySkill(/hint|提示|错题|为什么错/iu.test(turn.query)
        ? 'mistake-review'
        : state.research ? 'course-source-comparison' : 'concept-explanation')
      const draft = await askRole(model, profile, config.signal,
        'Role: tutor. Explain with a small example. For clarify, ask a focused question. For course claims, cite only the supplied evidence IDs in [id] format and mark unsupported claims as unverified. Return {answer,evidenceIds}.',
        { ...base, history, skill, intent: state.intent, research: state.research?.findings, limitations: state.research?.limitations, plan: state.plan, feedback: state.review?.reason }, studyDraft)
      await emit('study_role_completed', { subagentName: 'tutor' })
      return { draft: draft ?? null }
    })
    .addNode('verify', async (state, config) => {
      const available = new Set(state.research?.evidence.map(item => item.evidenceId))
      if (!state.draft || state.draft.evidenceIds.some(id => !available.has(id))) {
        return { review: { decision: 'repair' as const, reason: 'Repair missing or invalid course citations.', needsEvidence: false } }
      }
      const review = await askRole(model, 'strong', config.signal,
        'Role: independent verifier. Check claims against the supplied evidence and the plan against time constraints. Return {decision:accept|repair,reason,needsEvidence}. Give a precise reason for repair.',
        { ...base, draft: state.draft, plan: state.plan, evidence: state.research?.evidence.map(item => ({
          id: item.evidenceId, title: item.title, text: item.content.slice(0, 2_500),
        })) }, verification)
      await emit('study_role_completed', { subagentName: 'verifier' })
      return { review: review ?? { decision: 'repair' as const, reason: 'Independent verification was unavailable.', needsEvidence: false } }
    })
    .addNode('revise', state => ({ revision: state.revision + 1 }))
    .addNode('finish', state => {
      const available = new Set(state.research?.evidence.map(item => item.evidenceId))
      const verified = state.review?.decision !== 'repair' && state.draft?.evidenceIds.every(id => available.has(id))
      const requiresSources = state.intent?.intent === 'verify_sources' || state.intent?.intent === 'verify_and_plan'
      const fallback = /[\u3400-\u9fff]/u.test(turn.query)
        ? '这次未能验证课程依据或草稿。可以补充课程资料或缩小问题范围。'
        : 'I could not verify the course evidence or draft. Please add a source or narrow the question.'
      const supported = !requiresSources || Boolean(state.draft?.evidenceIds.length)
      const answer = verified && supported ? state.draft?.answer ?? fallback : fallback
      return { answer, messages: [new AIMessage(answer)] }
    })
    .addEdge(START, 'understand')
    .addConditionalEdges('understand', state => {
      if (state.intent?.intent === 'verify_sources' || state.intent?.intent === 'verify_and_plan') return 'gather_evidence'
      return state.intent?.intent === 'plan' ? 'draft_plan' : 'tutor'
    }, ['gather_evidence', 'draft_plan', 'tutor'])
    .addConditionalEdges('gather_evidence', state => state.intent?.intent === 'verify_and_plan' ? 'draft_plan' : 'tutor', ['draft_plan', 'tutor'])
    .addEdge('draft_plan', 'tutor')
    .addConditionalEdges('tutor', state =>
      state.intent?.intent === 'explain' || state.intent?.intent === 'clarify' ? 'finish' : 'verify', ['finish', 'verify'])
    .addConditionalEdges('verify', state =>
      state.review?.decision === 'repair' && state.revision === 0 ? 'revise' : 'finish', ['revise', 'finish'])
    .addConditionalEdges('revise', state => {
      if (state.review?.needsEvidence && course && (state.research?.actions ?? 0) < RESEARCH_SUBAGENT_ACTION_BUDGET) return 'gather_evidence'
      if (state.intent?.intent === 'plan' || state.intent?.intent === 'verify_and_plan') return 'draft_plan'
      return 'tutor'
    }, ['gather_evidence', 'draft_plan', 'tutor'])
    .addEdge('finish', END)
    .compile({ checkpointer: input.checkpointer })
}
