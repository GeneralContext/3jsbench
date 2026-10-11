// A task is one folder, tasks/<name>/, holding prompt.md: the brief the model
// is given, plus exactly one final LF.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASKS_DIR = fileURLToPath(new URL('../tasks/', import.meta.url));

/** Task folder names, sorted. */
export async function listTasks(dir = TASKS_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

/** One task, by folder name: { id, prompt }. */
export async function loadTask(name, dir = TASKS_DIR) {
  if (!(await listTasks(dir)).includes(name)) throw new Error('Unknown task: ' + name);
  const text = await readFile(path.join(dir, name, 'prompt.md'), 'utf8');
  if (text.includes('\r') || !text.endsWith('\n') || text.endsWith('\n\n') || !text.trim())
    throw new Error(`${name}/prompt.md must be nonempty, end with exactly one LF and contain no CR`);
  return { id: name, prompt: text.slice(0, -1) };
}
