import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listTasks, loadTask } from '../src/tasks.js';
import { PROMPT_SHA256, SYSTEM_PROMPT, requestMessages } from '../src/prompt.js';

test('the system prompt is pinned', () => {
  assert.equal(PROMPT_SHA256, '4877dcbae3c85c37078fae7a2b6a7a87060550e5855eeed0eeee26296b4359c6');
  assert.equal(createHash('sha256').update(SYSTEM_PROMPT).digest('hex'), PROMPT_SHA256);
});

test('the user message is the brief alone', async () => {
  const task = await loadTask('spiral-staircase');
  assert.deepEqual(requestMessages(task), [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: task.prompt }] },
  ]);
});

test('every task loads, with a brief ending in no newline', async () => {
  const names = await listTasks();
  assert.equal(names.length, 100);
  for (const name of names) {
    const task = await loadTask(name);
    assert.ok(task.prompt.trim() && !task.prompt.endsWith('\n'), name);
  }
});

test('an unknown task is refused', async () => {
  await assert.rejects(loadTask('../tasks'), /Unknown task/);
});
