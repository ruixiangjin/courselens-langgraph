import type { AgentEventType, StudyTurnInput } from '@monash-study/study-core'

export const studyQuestion = {
  query: 'Compare the backup schedule with the recovery objective.',
  courseContext: { courseCode: 'DEMO' },
} satisfies StudyTurnInput

export const continuityMarker = 'ORANGE-731'

export const continuityQuestions = [
  `The marker for this conversation is ${continuityMarker}.`,
  'What marker did I give you earlier?',
] as const

export const completedTurnEvents: readonly AgentEventType[] = [
  'run_started',
  'model_started',
  'model_completed',
  'answer_completed',
  'run_completed',
]
