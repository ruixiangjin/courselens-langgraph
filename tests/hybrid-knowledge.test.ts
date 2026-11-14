import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HybridKnowledgeService } from '@monash-study/knowledge-service'

test('falls back to keyword retrieval with course, week and page provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'courselens-hybrid-'))
  try {
    for (const [course, week, page] of [['FIT2004', 5, 2], ['FIT2004', 6, 3], ['FIT2014', 5, 4]] as const) {
      const folder = join(root, course, 'local')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, week + '.json'), JSON.stringify({
        documentId: course + week, resourceId: course + '-' + week, title: 'Graph traversal',
        course, week, source: 'local', contentType: 'document', text: 'BFS uses a queue.',
        sourcePath: '/private/course.pdf', sourceHash: 'version-' + page, normalizedHash: 'normalized',
        normalizationVersion: '1', locator: { kind: 'document', pageText: [{ page, text: 'BFS uses a queue.' }] },
      }))
    }
    const service = new HybridKnowledgeService({ async search() { throw new Error('semantic offline') } }, root)
    const result = await service.search({ query: 'BFS', course: 'FIT2004', week: 5 })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.metadata.page, 2)
    assert.equal(result[0]?.metadata.sourceHash, 'version-2')
  } finally { await rm(root, { recursive: true, force: true }) }
})
