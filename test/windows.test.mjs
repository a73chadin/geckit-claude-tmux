import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backgroundTasks } from '../src/background-tasks.mjs'
import { launchLine, locateTmux } from '../src/provider.mjs'

const windows = { skip: process.platform !== 'win32' }
const runtime = { claudeCommand: () => 'C:\\Program Files\\Claude\\claude.exe', OFF_PLAN: ['ANTHROPIC_API_KEY'], planOnly: () => ({}) }
const timestamp = '2026-10-11T06:41:57.518Z'

test('builds a psmux command line that quotes whole arguments only', windows, () => {
  assert.equal(launchLine(runtime, {}, ['--settings', 'C:\\Temp Folder\\settings.json', '--model', 'haiku', 'C:\\Trailing Dir\\']), '"C:\\Program Files\\Claude\\claude.exe" --settings "C:\\Temp Folder\\settings.json" --model haiku "C:\\Trailing Dir\\\\"')
  assert.equal(launchLine(runtime, {}), '"C:\\Program Files\\Claude\\claude.exe"')
})

test('refuses arguments psmux would rewrite', windows, () => {
  assert.throws(() => launchLine(runtime, {}, ['{"a":1}']), /quotes and dollar signs/)
  assert.throws(() => launchLine(runtime, {}, ['C:\\$Recycle']), /quotes and dollar signs/)
})

test('reads background task output from the Windows Claude temp folder', windows, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'claude-task-test-')))
  const updates = []
  const tracker = backgroundTasks('E:\\work\\project', 'session', { CLAUDE_CODE_TMPDIR: folder }, (task) => updates.push(task))
  try {
    await tracker.read({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'use', name: 'Bash', input: { description: 'Watch', command: 'ping -t 127.0.0.1' } }] } })
    await tracker.read({ type: 'user', timestamp, toolUseResult: { backgroundTaskId: 'bg92qqid0' }, message: { content: [{ type: 'tool_result', tool_use_id: 'use', content: '' }] } })
    assert.equal(updates.at(-1).output, join(folder, 'claude', 'E--work-project', 'session', 'tasks', 'bg92qqid0.output'))
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('finds psmux and runs it on a server of its own', windows, async (t) => {
  // A shell opened before the install has no psmux on PATH; the WinGet and Scoop folders still find it.
  const found = await locateTmux().catch(() => undefined)
  if (found === undefined) { t.skip('psmux is not installed'); return }
  assert.match(execFileSync(found.file, ['-V'], { encoding: 'utf8' }), /psmux/)
  assert.deepEqual(found.server, ['-L', 'geckit'])
})

test('says how to install psmux when none is found', windows, async () => {
  await assert.rejects(locateTmux({ env: { PATH: '' }, known: [] }), /winget install marlocarlo\.psmux/)
})
