import type { BaseMessage } from '@langchain/core/messages'

const redact = (text: string) => text.replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')

export function studyHistory(messages: readonly BaseMessage[]) {
  const recent = messages.slice(-8).map(message => ({ role: message.type, text: redact(message.text).slice(0, 2_000) }))
  const older = messages.slice(0, -8).filter(message => message.type === 'human').slice(-4)
    .map(message => redact(message.text).replace(/\s+/gu, ' ').trim().slice(0, 180))
  return { recent, ...(older.length ? { earlierTopics: older } : {}) }
}
