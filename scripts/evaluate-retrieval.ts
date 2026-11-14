import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { HybridKnowledgeService, LightRAGKnowledgeService, loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'
import { z } from 'zod'

const benchmark = z.array(z.object({
  question: z.string().min(1), course: z.string().min(1),
  week: z.number().int().nonnegative().optional(),
  expectedDocumentIds: z.array(z.string().min(1)).min(1),
})).min(1)
const path = process.argv[2]
if (!path) throw new Error('Pass a JSON file with question, course and expectedDocumentIds for each case.')
const cases = benchmark.parse(JSON.parse(await readFile(path, 'utf8')))
const config = loadRuntimeConfig()
loadApplicationEnvironment(config.applicationRoot)
const semantic = new LightRAGKnowledgeService({ runtimeConfig: config })
const hybrid = new HybridKnowledgeService(semantic, config.normalizedRoot)
const topK = 4
try {
  for (const [mode, service] of [['lightrag', semantic], ['hybrid', hybrid]] as const) {
    const results: { course: string; recall: number; precision: number; hit: number; reciprocalRank: number; ndcg: number; ms: number }[] = []
    for (const { expectedDocumentIds, question, course, week } of cases) {
      const started = performance.now()
      const resultsForQuery = await service.search({ query: question, course, ...(week === undefined ? {} : { week }), limit: topK, signal: AbortSignal.timeout(45_000) })
      const expected = new Set(expectedDocumentIds)
      const seen = new Set<string>()
      const relevance = resultsForQuery.map(item => {
        const id = item.metadata.documentId
        if (typeof id !== 'string' || !expected.has(id) || seen.has(id)) return 0
        seen.add(id)
        return 1
      })
      const first = relevance.indexOf(1)
      const dcg = relevance.reduce<number>((sum, item, index) => sum + item / Math.log2(index + 2), 0)
      const ideal = Array.from({ length: Math.min(topK, expected.size) }, (_, index) => 1 / Math.log2(index + 2))
        .reduce((sum, value) => sum + value, 0)
      results.push({
        course, recall: seen.size / expected.size, precision: seen.size / topK,
        hit: Number(first >= 0), reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
        ndcg: dcg / ideal, ms: Math.round(performance.now() - started),
      })
    }
    const average = (key: 'recall' | 'precision' | 'hit' | 'reciprocalRank' | 'ndcg') =>
      results.reduce((sum, item) => sum + item[key], 0) / results.length
    const times = results.map(item => item.ms).sort((a, b) => a - b)
    console.log(JSON.stringify({
      mode, topK, count: results.length, recall: average('recall'), precision: average('precision'),
      hitRate: average('hit'), mrr: average('reciprocalRank'), ndcg: average('ndcg'),
      p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], results,
    }))
  }
} finally { semantic.close() }
