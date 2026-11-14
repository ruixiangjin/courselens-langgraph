import { createHash } from 'node:crypto'
import type { Evidence } from '@monash-study/shared-types'
import type { KnowledgeQuery, KnowledgeService } from '@monash-study/study-core'
import { NormalizedDocumentLoader } from '../normalization/normalized-document-loader.js'

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

export class HybridKnowledgeService implements KnowledgeService {
  readonly #loader: NormalizedDocumentLoader
  constructor(readonly semantic: KnowledgeService, normalizedRoot: string) {
    this.#loader = new NormalizedDocumentLoader({ normalizedRoot })
  }

  async search(query: KnowledgeQuery): Promise<readonly Evidence[]> {
    if (!query.course) throw new Error('Knowledge query requires a course')
    const limit = Math.min(12, Math.max(1, query.limit ?? 6))
    const candidates = await Promise.allSettled([
      this.semantic.search({ ...query, limit: limit * 2 }),
      this.#keyword(query, limit * 2),
    ])
    query.signal?.throwIfAborted()
    if (candidates.every(result => result.status === 'rejected')) {
      throw new Error('Both course retrieval methods failed.')
    }
    const ranked = new Map<string, { item: Evidence; score: number }>()
    for (const result of candidates) {
      if (result.status === 'rejected') continue
      result.value.forEach((item, index) => {
        if (item.course !== query.course) return
        const key = JSON.stringify([item.resourceId ?? item.evidenceId, item.content.replace(/\s+/gu, ' ').trim()])
        const score = 1 / (12 + index) + (ranked.get(key)?.score ?? 0)
        ranked.set(key, { item: ranked.get(key)?.item ?? item, score })
      })
    }
    const tokens = new Set(words(query.query))
    return [...ranked.values()].map(({ item, score }) => ({
      item,
      score: score + new Set(words(item.title + ' ' + item.content).filter(word => tokens.has(word))).size * 0.005,
    })).sort((a, b) => b.score - a.score || a.item.evidenceId.localeCompare(b.item.evidenceId))
      .slice(0, limit).map(({ item }) => item)
  }

  async #keyword(query: KnowledgeQuery, limit: number): Promise<Evidence[]> {
    const course = query.course!
    const terms = [...new Set(words(query.query))]
    const documents = await this.#loader.list({ course })
    query.signal?.throwIfAborted()
    const chunks = documents.filter(doc => query.week === undefined || query.week === doc.week).flatMap(doc => {
      const pages = doc.locator.pageText?.length ? doc.locator.pageText : [{ page: undefined, text: doc.text }]
      return pages.flatMap(({ page, text }) => {
        const paragraphs = text.split(/\n\s*\n/u).flatMap(part => part.match(/[\s\S]{1,1600}/gu) ?? [])
        return paragraphs.filter(content => content.trim()).map((content, index) => ({ doc, page, content, index, tokens: words(content) }))
      })
    })
    const documentFrequency = terms.map(term => chunks.filter(chunk => chunk.tokens.includes(term)).length)
    const averageLength = chunks.reduce((total, chunk) => total + chunk.tokens.length, 0) / Math.max(chunks.length, 1) || 1
    return chunks.map(chunk => ({
      ...chunk,
      score: terms.reduce((total, term, index) => {
        const occurrences = chunk.tokens.filter(token => token === term).length
        const frequency = documentFrequency[index] ?? 0
        const idf = Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5))
        const lengthPenalty = 1.2 * (0.25 + 0.75 * chunk.tokens.length / averageLength)
        return total + idf * (occurrences * 2.2) / (occurrences + lengthPenalty)
      }, 0),
    })).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ doc, page, content, index, score }) => ({
        evidenceId: 'bm25-' + createHash('sha256').update(JSON.stringify([doc.documentId, doc.sourceHash, page, index])).digest('hex').slice(0, 24),
        resourceId: doc.resourceId, title: doc.title, content, course, score,
        sourceSystem: doc.source, retrievalProvider: 'local' as const,
        metadata: { documentId: doc.documentId, sourceHash: doc.sourceHash, week: doc.week, ...(page === undefined ? {} : { page }) },
      }))
  }
}
