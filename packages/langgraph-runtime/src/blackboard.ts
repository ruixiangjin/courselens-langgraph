import { MessagesValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod'

export const studyIntent = z.enum(['explain', 'verify_sources', 'plan', 'verify_and_plan', 'clarify'])
export const understanding = z.object({ intent: studyIntent, objective: z.string().trim().min(1).max(2_000) })
export const studyDraft = z.object({
  answer: z.string().trim().min(1),
  evidenceIds: z.array(z.string()).max(12),
})
export const studyPlan = z.object({
  goal: z.string().trim().min(1),
  exercises: z.array(z.object({
    activity: z.string().trim().min(1), minutes: z.number().int().positive().max(180),
    checkpoint: z.string().trim().min(1),
  })).min(1).max(5),
})
export type StudyPlan = z.infer<typeof studyPlan>
export const verification = z.object({
  decision: z.enum(['accept', 'repair']),
  reason: z.string().trim().min(1).max(1_000),
  needsEvidence: z.boolean(),
})
const researchArtifact = z.object({
  evidence: z.array(z.custom<import('@monash-study/shared-types').Evidence>()),
  findings: z.array(z.object({ content: z.string(), evidenceIds: z.array(z.string()) })),
  limitations: z.array(z.string()),
  actions: z.number().int().nonnegative(),
  tools: z.array(z.string()),
})

export const StudyBlackboard = new StateSchema({
  messages: MessagesValue,
  intent: understanding.nullable().default(null),
  research: researchArtifact.nullable().default(null),
  plan: studyPlan.nullable().default(null),
  draft: studyDraft.nullable().default(null),
  review: verification.nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  answer: z.string().default(''),
})
