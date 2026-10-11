import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { backgroundTasks } from '../src/background-tasks.mjs'

const timestamp = '2026-10-11T06:41:57.518Z'
const use = (tool = 'Bash', id = 'use') => ({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name: tool, input: { description: 'Watch copy', command: 'tail -f copy.log' } }] } })
const result = (data, id = 'use') => ({ type: 'user', timestamp, toolUseResult: data, message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } })
const notice = (id, status, file = '') => ({ type: 'user', isMeta: true, timestamp, message: { content: `<task-notification><task-id>${id}</task-id><status>${status}</status><output-file>${file}</output-file><summary>Background task ${status} (exit code 0)</summary></task-notification>` } })

test('tracks native saved starts and exit markers without treating silence as completion', async () => {
  const folder = await realpath(await mkdtemp('/private/tmp/claude-task-test-'))
  const updates = []
  const tracker = backgroundTasks(folder, 'session', { CLAUDE_CODE_TMPDIR: folder }, (task) => updates.push(task))
  try {
    await tracker.read(use())
    await tracker.read(result({ backgroundTaskId: 'bg92qqid0' }))
    const task = updates.at(-1)
    assert.equal(task.command, 'tail -f copy.log')
    assert.equal(task.what, 'Watch copy')
    assert.equal(task.started, Date.parse(timestamp))
    assert.equal(task.status, 'running')
    assert.equal(task.output, join(folder, `claude-${process.getuid()}`, folder.replace(/[^A-Za-z0-9]/g, '-'), 'session', 'tasks', 'bg92qqid0.output'))
    await tracker.poll()
    assert.equal(updates.length, 1, 'missing file does not complete')
    await mkdir(join(task.output, '..'), { recursive: true })
    await writeFile(task.output, '')
    await tracker.poll()
    assert.equal(updates.length, 1, 'empty file does not complete')
    await writeFile(task.output, 'ordinary output\n[exited with code 0] trailing output')
    await tracker.poll()
    assert.equal(updates.length, 1, 'only a final exit marker completes')
    await writeFile(task.output, 'large output\n'.repeat(100000) + '\n[exited with code 0]\n')
    await tracker.poll()
    assert.equal(updates.at(-1).status, 'completed')
    assert.equal(updates.at(-1).exit, 0)
    assert(updates.at(-1).ended >= task.started)
    await tracker.poll()
    await tracker.read(result({ backgroundTaskId: task.id }))
    assert.equal(updates.length, 2, 'unchanged or duplicate records do not resurrect cleared tasks')
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('keeps helper output paths and waits for meta completion notices', async () => {
  const folder = await mkdtemp('/private/tmp/claude-helper-test-')
  const file = join(folder, 'agent.jsonl')
  const updates = []
  const tracker = backgroundTasks(folder, 'session', {}, (task) => updates.push(task))
  try {
    await tracker.read(use('Agent'))
    await tracker.read(result({ isAsync: true, agentId: 'agent-one', outputFile: file }))
    assert.equal(updates.at(-1).kind, 'local_agent')
    assert.equal(updates.at(-1).output, file)
    await writeFile(file, '\n[exited with code 0]\n')
    await tracker.poll()
    assert.equal(updates.length, 1, 'helper transcripts are not shell output')
    await tracker.read(notice('agent-one', 'completed', file))
    assert.equal(updates.at(-1).status, 'completed')
    assert.equal(updates.at(-1).exit, 0)
    assert.equal(updates.at(-1).ended, Date.parse(timestamp))
    await tracker.read(notice('agent-one', 'completed', file))
    assert.equal(updates.length, 2)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('reports failed output and killed notices, preserving finished tasks on process closure', async () => {
  const folder = await mkdtemp('/private/tmp/claude-failed-task-')
  const updates = []
  const tracker = backgroundTasks(folder, 'session', {}, (task) => updates.push(task))
  try {
    const outputFile = join(folder, 'failed.output')
    await tracker.read(use())
    await tracker.read(result({ backgroundTaskId: 'failed', outputFile }))
    await writeFile(outputFile, '\n[exited with code 7]\n')
    await tracker.poll()
    assert.equal(updates.at(-1).status, 'failed')
    assert.equal(updates.at(-1).exit, 7)
    await tracker.read(use('Monitor'))
    await tracker.read(result({ backgroundTaskId: 'watch' }))
    assert.equal(updates.at(-1).kind, 'monitor')
    await tracker.read(notice('watch', 'killed'))
    assert.equal(updates.at(-1).status, 'stopped')
    await tracker.read(result({ backgroundTaskId: 'running' }))
    tracker.stopped()
    assert.equal(updates.at(-1).id, 'running')
    assert.equal(updates.at(-1).status, 'stopped')
    const count = updates.length
    tracker.stopped()
    assert.equal(updates.length, count)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('restores task history silently and stops unresolved work from the old process', async () => {
  const updates = []
  const tracker = backgroundTasks('/private/tmp', 'session', {}, (task) => updates.push(task))
  await tracker.read(use(), true)
  await tracker.read(result({ backgroundTaskId: 'old-running' }), true)
  await tracker.read(result({ backgroundTaskId: 'old-completed' }), true)
  await tracker.read(notice('old-completed', 'completed'), true)
  tracker.stopped(true)
  assert.equal(updates.length, 0)
  tracker.publish()
  assert.deepEqual(updates.map((task) => [task.id, task.status]), [['old-running', 'stopped'], ['old-completed', 'completed']])
})

test('ignores sidechains, foreground helpers and invalid task IDs', async () => {
  const updates = []
  const tracker = backgroundTasks('/private/tmp', 'session', {}, (task) => updates.push(task))
  await tracker.read({ ...result({ backgroundTaskId: 'side' }), isSidechain: true })
  await tracker.read(result({ agentId: 'sync-agent', isAsync: false }))
  await tracker.read(result({ backgroundTaskId: '../outside' }))
  await tracker.read(notice('unknown', 'completed'))
  assert.equal(updates.length, 0)
})
