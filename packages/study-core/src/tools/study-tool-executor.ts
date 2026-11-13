import type { Evidence } from '@monash-study/shared-types'

import type { StudyAgentToolServices, StudyTurnInput } from '../agent-runtime.js'

export async function executeKnowledgeTool(
  name: 'search_knowledge' | 'get_resource',
  args: Record<string, unknown>,
  services: StudyAgentToolServices,
  input: StudyTurnInput,
  evidenceById: Map<string, Evidence>,
  signal?: AbortSignal,
  resourceScope?: string,
): Promise<unknown> {
  switch (name) {
    case 'search_knowledge': {
      if (services.knowledgeService === undefined) throw new Error('Knowledge search is unavailable')
      const query = requiredString(args, 'query')
      const course = optionalString(args, 'course') ?? input.courseContext?.courseCode
      if (course === undefined) throw new Error('search_knowledge requires a course')
      const week = optionalInteger(args, 'week')
      const limit = optionalInteger(args, 'limit')
      let evidence: readonly Evidence[]
      try {
        evidence = await services.knowledgeService.search({
          query,
          course,
          ...(week === undefined ? {} : { week }),
          ...(limit === undefined ? {} : { limit }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        throw new Error('Knowledge search failed')
      }
      for (const item of evidence) evidenceById.set(item.evidenceId, item)
      return {
        course,
        query,
        evidence: evidence.map(toModelFacingEvidence),
        evidenceCount: evidence.length,
      }
    }
    case 'get_resource': {
      if (services.resourceReader === undefined) throw new Error('Resource reading is unavailable')
      const resourceId = requiredString(args, 'resourceId')
      try {
        const resource = await services.resourceReader.readText(resourceId, resourceScope)
        return toModelFacingResourceText(resource)
      } catch {
        throw new Error('Resource read failed')
      }
    }
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function toModelFacingEvidence(evidence: Evidence): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const sourceMetadata = evidence.metadata
  for (const key of ['week', 'resourceSource', 'contentType', 'lightragChunkId', 'lightragReferenceId']) {
    const value = sourceMetadata[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value
    }
  }
  const locator = toModelFacingLocator(sourceMetadata.locator)
  if (locator !== undefined) metadata.locator = locator
  return {
    evidenceId: evidence.evidenceId,
    ...(evidence.resourceId === undefined ? {} : { resourceId: evidence.resourceId }),
    ...(evidence.course === undefined ? {} : { course: evidence.course }),
    title: evidence.title,
    content: evidence.content,
    sourceSystem: evidence.sourceSystem,
    retrievalProvider: evidence.retrievalProvider,
    ...(evidence.score === undefined ? {} : { score: evidence.score }),
    metadata,
  }
}

function toModelFacingResourceText(resourceText: {
  readonly resource: {
    readonly resourceId: string
    readonly course: string | null
    readonly week: number | null
    readonly title: string
    readonly source: string
    readonly resourceType: string
    readonly fileType: string
    readonly extension: string | null
    readonly relativePath: string
  }
  readonly content: string
}): Record<string, unknown> {
  return {
    resource: {
      resourceId: resourceText.resource.resourceId,
      course: resourceText.resource.course,
      week: resourceText.resource.week,
      title: resourceText.resource.title,
      source: resourceText.resource.source,
      resourceType: resourceText.resource.resourceType,
      fileType: resourceText.resource.fileType,
      extension: resourceText.resource.extension,
      relativePath: resourceText.resource.relativePath,
    },
    content: resourceText.content,
  }
}

function toModelFacingLocator(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const locator: Record<string, unknown> = {}
  for (const key of ['kind', 'sourceUrl', 'threadId', 'threadNumber']) {
    const item = value[key]
    if (typeof item === 'string' || typeof item === 'number') locator[key] = item
  }
  for (const key of ['pageNumbers']) {
    const item = value[key]
    if (Array.isArray(item) && item.every((page) => typeof page === 'number')) locator[key] = item
  }
  const regions = value.regions
  if (Array.isArray(regions)) {
    locator.regions = regions.flatMap((region) => {
      if (!isRecord(region) || typeof region.page !== 'number') return []
      return [{
        page: region.page,
        ...(typeof region.reference === 'string' ? { reference: region.reference } : {}),
      }]
    })
  }
  return Object.keys(locator).length === 0 ? undefined : locator
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
