import { readFileSync } from 'node:fs'

const names = ['concept-explanation', 'course-source-comparison', 'mistake-review', 'exam-study-plan'] as const

const skills = Object.fromEntries(names.map(name => {
  const file = new URL('../../../../skills/' + name + '/SKILL.md', import.meta.url)
  const contents = readFileSync(file, 'utf8')
  const match = /^---\nname: ([a-z-]+)\nversion: (\d+)\n---\n([\s\S]+)$/u.exec(contents)
  if (!match || match[1] !== name) throw new Error('Invalid study skill: ' + name)
  return [name, { version: match[2], guidance: match[3]?.trim() }]
}))

export function studySkill(name: typeof names[number]) {
  const skill = skills[name]!
  return { name, ...skill }
}
