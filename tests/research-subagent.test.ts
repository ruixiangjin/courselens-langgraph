import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseResearchResultText,
  validateResearchTask,
} from '@monash-study/study-core'

test('ResearchTask and ResearchResult contracts validate their first-version fields', () => {
  const task = validateResearchTask({
    taskId: ' research-1 ',
    objective: ' Compare merge strategies. ',
    course: ' FIT2109 ',
    topic: 'Git',
    week: 4,
  })
  assert.deepEqual(task, {
    taskId: 'research-1',
    objective: 'Compare merge strategies.',
    course: 'FIT2109',
    topic: 'Git',
    week: 4,
  })
  assert.throws(() => validateResearchTask({ taskId: 'x', objective: ' ', course: 'FIT2109' }), /objective/)
  assert.throws(() => validateResearchTask({ taskId: 'x', objective: 'Research', course: 'FIT2109', week: -1 }), /week/)
})

test('ResearchResult attribution filters fabricated Evidence IDs', () => {
  const result = parseResearchResultText(JSON.stringify({
    taskId: 'research-1',
    summary: 'The materials distinguish the two cases.',
    findings: [
      { content: 'Fast-forward merge is covered.', evidenceIds: ['evidence-a', 'fabricated-id'] },
      { content: 'Conflict resolution is also covered.', evidenceIds: ['evidence-b'] },
    ],
    evidenceIds: ['evidence-a', 'fabricated-id'],
    limitations: [],
  }), {
    taskId: 'research-1', objective: 'Compare merges.', course: 'FIT2109',
  }, new Set(['evidence-a', 'evidence-b']))

  assert.deepEqual(result.evidenceIds, ['evidence-a', 'evidence-b'])
  assert.deepEqual(result.findings.map(finding => finding.evidenceIds), [['evidence-a'], ['evidence-b']])
  assert.equal(result.limitations.length, 1)
  assert.match(result.limitations[0] ?? '', /discarded/)
})
