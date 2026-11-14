const byId = id => document.getElementById(id)
const sessions = new Map(Object.entries(JSON.parse(sessionStorage.getItem('courselens-sessions') ?? '{}')))
const status = byId('status')
const request = async (path, body) => {
  const response = await fetch('/api' + path, {
    headers: { authorization: 'Bearer ' + byId('token').value.trim(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}
function element(tag, text, parent) {
  const node = document.createElement(tag)
  node.textContent = text
  parent.append(node)
  return node
}
async function showProgress(turn, signal) {
  for (;;) {
    const response = await fetch('/api/turns/' + turn + '/events', {
      headers: { authorization: 'Bearer ' + byId('token').value.trim() }, signal,
    })
    if (response.status === 404) {
      await new Promise(resolve => setTimeout(resolve, 120))
      signal.throwIfAborted()
      continue
    }
    if (!response.ok || !response.body) return
    const stream = response.body.pipeThrough(new TextDecoderStream()).getReader()
    try {
      let pending = ''
      for (;;) {
        const { value, done } = await stream.read()
        if (done || signal.aborted) return
        pending += value
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const event = JSON.parse(line.slice(6))
          if (event.type === 'subagent_started') status.textContent = '正在核对课程资料…'
          if (event.subagentName === 'verifier') status.textContent = '正在复核结论和引用…'
          if (event.subagentName === 'planner') status.textContent = '正在安排复习练习…'
        }
      }
    } finally {
      await stream.cancel().catch(() => {})
      stream.releaseLock()
    }
  }
}
async function approve(id, button, article) {
  button.disabled = true
  try {
    await request('/turns/' + id + '/approve', {})
    button.textContent = '复习卡生成中'
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const job = await request('/jobs/' + id)
      if (job.status === 'done') {
        button.remove()
        const cards = element('ul', '', article)
        for (const card of job.result) element('li', card.prompt + ' · ' + card.minutes + ' 分钟 · ' + card.check, cards)
        return
      }
      if (job.status === 'dead') throw new Error('复习卡生成失败')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    button.textContent = '查看生成进度'
  } catch (error) { status.textContent = error.message }
  button.disabled = false
}
byId('study').addEventListener('submit', async event => {
  event.preventDefault()
  const submit = event.submitter
  submit.disabled = true
  status.textContent = '正在学习资料并整理回答…'
  const course = byId('course').value.trim().toUpperCase()
  const key = course || 'general'
  const session = sessions.get(key) ?? crypto.randomUUID()
  sessions.set(key, session)
  sessionStorage.setItem('courselens-sessions', JSON.stringify(Object.fromEntries(sessions)))
  const turn = crypto.randomUUID()
  const question = byId('question').value
  const progress = new AbortController()
  void showProgress(turn, progress.signal).catch(() => {})
  try {
    const result = await request('/turns', { session, turn, question, ...(course ? { course } : {}) })
    const article = element('article', '', byId('answers'))
    element('h2', question, article)
    element('p', result.answer, article)
    for (const source of result.evidence) {
      const details = element('details', '', article)
      element('summary', source.title + (source.page ? ' · 第 ' + source.page + ' 页' : ''), details)
      element('p', source.content, details)
    }
    if (result.plan) {
      element('h3', result.plan.goal, article)
      const list = element('ul', '', article)
      for (const exercise of result.plan.exercises) element('li', exercise.activity + ' · ' + exercise.minutes + ' 分钟', list)
      const button = element('button', '确认并生成复习卡', article)
      button.addEventListener('click', () => approve(turn, button, article))
    }
    status.textContent = ''
  } catch (error) { status.textContent = error.message }
  finally { progress.abort(); submit.disabled = false }
})
byId('reset').addEventListener('click', () => {
  sessions.delete(byId('course').value.trim().toUpperCase() || 'general')
  sessionStorage.setItem('courselens-sessions', JSON.stringify(Object.fromEntries(sessions)))
  byId('answers').replaceChildren()
})
byId('operator').addEventListener('click', async () => {
  try {
    const trace = await request('/trace')
    byId('trace').hidden = false
    byId('events').textContent = trace.map(({ seq, event }) => [seq, event.type, event.route, event.subagentName, event.errorCode].filter(Boolean).join(' · ')).join('\n')
  } catch (error) { status.textContent = error.message }
})
