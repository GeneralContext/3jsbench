#!/usr/bin/env node
// 3jsbench command line: list the tasks, write their exact requests, generate attempts.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listTasks, loadTask } from '../src/tasks.js';
import { requestMessages } from '../src/prompt.js';
import { generateAttempt, generationSettings, savedAttempt } from '../src/generation.js';

const HELP = `3jsbench: generate Three.js programs for the 3JSBench tasks.

  3jsbench tasks
  3jsbench prompts --out DIR
  3jsbench generate --model MODEL --out DIR [--tasks all|a,b,...] [--attempts 3] [--concurrency 4]
                    [--provider SLUG | --base-url URL]

prompts writes each task's exact request (system and user messages) to DIR/<task>.json.
generate sends each request to MODEL and saves the reply verbatim as DIR/<task>/<n>/asset.ts,
beside the request, every response and the parsed completion. DIR/generation.json records the
settings. Rerunning generate skips finished attempts and never re-sends a request that may have
reached the provider; delete an attempt folder to send its request again.

generate calls MODEL through OpenRouter (OPENROUTER_API_KEY); --provider requires one OpenRouter
provider. With --base-url, it calls an OpenAI-compatible server directly, with the
optional key THREEJSBENCH_ENDPOINT_KEY, never sent over plain http except to a loopback address.`;

const OPTIONS = {
  out: { type: 'string' },
  model: { type: 'string' },
  tasks: { type: 'string', default: 'all' },
  attempts: { type: 'string', default: '3' },
  concurrency: { type: 'string', default: '4' },
  provider: { type: 'string' },
  'base-url': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

function count(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(flag + ' must be a positive integer');
  return n;
}

async function selectTasks(list) {
  const names = list === 'all' ? await listTasks() : list.split(',');
  if (new Set(names).size !== names.length) throw new Error('--tasks names a task twice');
  return Promise.all(names.map(name => loadTask(name)));
}

const exists = file =>
  access(file).then(
    () => true,
    () => false,
  );

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The settings a run directory records; a rerun must use the same ones. */
async function recordSettings(out, settings) {
  const file = path.join(out, 'generation.json'),
    text = JSON.stringify(settings, null, 2) + '\n';
  await mkdir(out, { recursive: true });
  if (!(await exists(file))) return writeFile(file, text, { flag: 'wx' });
  if ((await readFile(file, 'utf8')) !== text)
    throw new Error(`${file} records other settings; use another --out`);
}

async function generate(v) {
  if (!v.out) throw new Error('--out is required');
  const settings = generationSettings({
    model: v.model,
    provider: v.provider ?? null,
    baseUrl: v['base-url'] ?? null,
  });
  const tasks = await selectTasks(v.tasks);
  const attempts = count(v.attempts, '--attempts'),
    concurrency = count(v.concurrency, '--concurrency');
  await recordSettings(v.out, settings);
  const jobs = tasks.flatMap(task =>
    Array.from({ length: attempts }, (_, n) => ({ task, dir: path.join(v.out, task.id, String(n + 1)) })),
  );
  const tally = { replied: 0, unanswered: 0, unfinished: 0 };
  await pool(jobs, concurrency, async ({ task, dir }) => {
    const name = path.relative(v.out, dir);
    const saved = await savedAttempt({ task, dir });
    if (saved) return tally[saved.replied ? 'replied' : 'unanswered']++;
    if (await exists(dir)) {
      // A call was sent but never finished; it may have been billed.
      console.error(`${name}: a previous call did not finish and may have reached the provider`);
      return tally.unfinished++;
    }
    await mkdir(path.dirname(dir), { recursive: true });
    const { replied, reason } = await generateAttempt({ task, settings, dir });
    tally[replied ? 'replied' : 'unanswered']++;
    console.error(`${name}: ${replied ? 'reply saved' : 'no reply'}${reason ? ` (${reason})` : ''}`);
  });
  const unfinished = tally.unfinished ? `, ${tally.unfinished} unfinished` : '';
  console.log(
    `${jobs.length} attempts: ${tally.replied} with a reply, ${tally.unanswered} without${unfinished}.`,
  );
  if (tally.unanswered || tally.unfinished)
    console.log('To send a request again, delete its attempt folder and rerun.');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') return console.log(HELP);
  const { values: v } = parseArgs({ args, options: OPTIONS, strict: true });
  if (!command || v.help) return console.log(HELP);
  if (command === 'tasks') return console.log((await listTasks()).join('\n'));
  if (command === 'prompts') {
    if (!v.out) throw new Error('--out is required');
    await mkdir(v.out, { recursive: true });
    for (const task of await selectTasks('all'))
      await writeFile(
        path.join(v.out, task.id + '.json'),
        JSON.stringify({ messages: requestMessages(task) }, null, 2) + '\n',
      );
    return;
  }
  if (command === 'generate') return generate(v);
  throw new Error('Unknown command: ' + command + '\n\n' + HELP);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
