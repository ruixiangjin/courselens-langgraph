import { AIMessage } from '@langchain/core/messages'
import type { StudyChatModel } from '@monash-study/langgraph-runtime'
import type { Evidence } from '@monash-study/shared-types'
import type { KnowledgeService } from '@monash-study/study-core'

const lecture: Evidence = {
  evidenceId: 'demo-bfs', course: 'FIT2004', title: 'Demo notes: traversing graphs',
  content: 'BFS discovers nodes in order of their minimum edge count from the start in an unweighted graph.',
  sourceSystem: 'local', retrievalProvider: 'local', metadata: { page: 1 },
}
export const demoKnowledge: KnowledgeService = {
  async search({ course }) { return course === lecture.course ? [lecture] : [] },
}

const json = (payload: unknown) => new AIMessage(JSON.stringify(payload))
export const demoModel: StudyChatModel = async (messages, _profile, _signal, tools) => {
  const role = messages[0]?.text ?? ''
  const text = messages[1]?.text ?? '{}'
  if (role.includes('Role: understanding')) {
    const { question } = JSON.parse(text) as { question: string }
    const courseWork = /lecture|tutorial|FIT2004|讲义|课件|练习|复习/i.test(question)
    const plan = /plan|practice|安排|复习|练习/i.test(question)
    return json({ intent: courseWork ? plan ? 'verify_and_plan' : 'verify_sources' : 'explain', objective: question })
  }
  if (role.includes('Role: study planner')) return json({
    goal: 'Explain when BFS gives the shortest path',
    exercises: [
      { activity: 'Trace a BFS queue on an unweighted graph', minutes: 15, checkpoint: 'Write the distance to each vertex' },
      { activity: 'Compare BFS with DFS on the same graph', minutes: 20, checkpoint: 'Give a DFS counterexample' },
    ],
  })
  if (role.includes('Role: tutor')) {
    const data = JSON.parse(text) as { research?: unknown; feedback?: string; intent?: { intent: string } }
    if (data.intent?.intent === 'clarify') return json({ answer: 'Which course materials should I check?', evidenceIds: [] })
    return data.research ? json({
      answer: data.feedback
        ? 'BFS finds paths with the fewest edges in an unweighted graph [demo-bfs]. DFS can explore a longer route first.'
        : 'BFS always finds the shortest path [demo-bfs].',
      evidenceIds: ['demo-bfs'],
    }) : json({ answer: 'BFS explores a graph one layer at a time.', evidenceIds: [] })
  }
  if (role.includes('Role: independent verifier')) {
    const { draft } = JSON.parse(text) as { draft: { answer: string } }
    const repair = draft.answer.includes('always')
    return json({ decision: repair ? 'repair' : 'accept', reason: repair ? 'Check the unweighted graph condition.' : 'Supported by the lecture.', needsEvidence: repair })
  }
  const task = JSON.parse(text.split('\n')[1] ?? '{}') as { taskId: string; objective: string }
  if (messages.at(-1)?.type === 'tool') return json({
    taskId: task.taskId, summary: lecture.content, limitations: [],
    findings: [{ content: lecture.content, evidenceIds: [lecture.evidenceId] }], evidenceIds: [lecture.evidenceId],
  })
  if (tools?.some(tool => tool.name === 'search_knowledge')) return new AIMessage({
    content: '', tool_calls: [{ name: 'search_knowledge', id: task.taskId, args: { query: task.objective } }],
  })
  return json({ taskId: task.taskId, summary: '', findings: [], evidenceIds: [], limitations: ['No course tool'] })
}
