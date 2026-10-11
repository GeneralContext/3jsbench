import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTask } from '../src/tasks.js';
import { requestMessages } from '../src/prompt.js';
import { generateAttempt, generationSettings } from '../src/generation.js';
import { callModel, parseCompletion, requestBody } from '../src/model-call.js';

const routed = generationSettings({ model: 'vendor/model', provider: 'vendor' });
const lab = generationSettings({ model: 'my-model', baseUrl: 'https://models.example/v1/' });
const scratch = async () => path.join(await mkdtemp(path.join(tmpdir(), '3jsbench-')), 'attempt');
const noDelay = async () => {};

const completion = (content, extra = {}) => ({
  id: 'gen-1',
  model: 'vendor/model',
  provider: 'Vendor',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { cost: 0.5, completion_tokens_details: { reasoning_tokens: 100 } },
  ...extra,
});
const reply = (status, body) => ({ status, text: JSON.stringify(body), requestId: 'req' });

test('every model is asked at high reasoning with the same budget', () => {
  assert.deepEqual(routed, {
    model: 'vendor/model',
    api: 'openrouter',
    provider: 'vendor',
    reasoning: 'high',
    maxTokens: 64_000,
    promptSha256: '4877dcbae3c85c37078fae7a2b6a7a87060550e5855eeed0eeee26296b4359c6',
    transport: { attempts: 3, maxResponseBytes: 8 * 1024 * 1024 },
  });
  const body = requestBody(routed, []);
  assert.deepEqual(body.provider, {
    only: ['vendor'],
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
  });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.max_tokens, 64_000);
  assert.equal('temperature' in body, false);
  // Without --provider, OpenRouter chooses the provider, still without fallbacks.
  assert.deepEqual(requestBody(generationSettings({ model: 'vendor/model' }), []).provider, {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
  });
});

test('an OpenAI-compatible server gets a plain Chat Completions request', () => {
  assert.equal(lab.baseUrl, 'https://models.example/v1');
  assert.equal(lab.provider, undefined);
  assert.deepEqual(requestBody(lab, []), {
    model: 'my-model',
    messages: [],
    max_completion_tokens: 64_000,
    reasoning_effort: 'high',
    stream: false,
  });
  assert.throws(() => generationSettings({ model: 'm', baseUrl: 'https://u:p@host/v1' }), /credentials/);
  assert.throws(() => generationSettings({ model: 'm', baseUrl: 'ftp://host/v1' }), /http/);
  assert.throws(
    () => generationSettings({ model: 'm', baseUrl: 'https://host/v1', provider: 'x' }),
    /OpenRouter/,
  );
  assert.throws(() => generationSettings({ model: 'm', provider: 'Bad Slug' }), /slug/);
  assert.throws(() => generationSettings({}), /--model/);
});

test('a reply is accepted only from the requested model on the required provider', () => {
  assert.equal(parseCompletion(completion('code'), routed).ok, true);
  assert.equal(parseCompletion(completion('  '), routed).reason, 'empty-output');
  assert.equal(
    parseCompletion(completion('code', { provider: 'Google' }), routed).reason,
    'served-provider-mismatch-or-missing',
  );
  assert.equal(
    parseCompletion(completion('code', { model: 'vendor/other' }), routed).reason,
    'served-model-mismatch-or-missing',
  );
  const cut = completion('code');
  cut.choices[0].finish_reason = 'length';
  assert.equal(parseCompletion(cut, routed).reason, 'incomplete-output:length');
  assert.equal(parseCompletion({ error: { code: 400, message: 'bad' } }, routed).reason, 'provider-error');
  assert.equal(parseCompletion({ choices: [] }, routed).reason, 'invalid-provider-response');
  // An OpenAI-compatible server may name its model differently; the name is saved, not checked.
  const served = parseCompletion(completion('code', { model: 'my-model-2026', provider: undefined }), lab);
  assert.equal(served.ok, true);
  assert.equal(served.model, 'my-model-2026');
});

test('the request is re-sent only when the provider provably did not process it', async () => {
  const sent = [];
  const sequence = responses => async body => {
    sent.push(body);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const retried = await callModel({
    settings: routed,
    messages: [],
    dir: await scratch(),
    key: 'k',
    delay: noDelay,
    send: sequence([new Error('ECONNREFUSED'), reply(429, {}), reply(200, completion('code'))]),
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.calls.length, 3);
  assert.equal(new Set(sent).size, 1);

  for (const failure of [reply(500, {}), new Error('ECONNRESET')]) {
    const result = await callModel({
      settings: routed,
      messages: [],
      dir: await scratch(),
      key: 'k',
      delay: noDelay,
      send: sequence([failure, reply(200, completion('code'))]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.calls.length, 1);
  }
});

test('a call leaves its request, responses and completion, and never reuses a directory', async () => {
  const dir = await scratch();
  const send = async () => reply(200, completion('code'));
  await callModel({ settings: routed, messages: [], dir, key: 'k', send });
  assert.deepEqual((await readdir(dir)).sort(), ['completion.json', 'request.json', 'response-1.json']);
  await assert.rejects(callModel({ settings: routed, messages: [], dir, key: 'k', send }), /EEXIST/);
});

test('keys are required for OpenRouter and never sent over plain http to a remote host', async () => {
  await assert.rejects(
    callModel({ settings: routed, messages: [], dir: await scratch(), key: '' }),
    /OPENROUTER_API_KEY/,
  );
  const remote = generationSettings({ model: 'm', baseUrl: 'http://models.example/v1' });
  await assert.rejects(
    callModel({ settings: remote, messages: [], dir: await scratch(), key: 'k' }),
    /plain http/,
  );
  const local = generationSettings({ model: 'm', baseUrl: 'http://127.0.0.1:8000/v1' });
  const send = async () => reply(200, completion('code', { model: 'm' }));
  assert.equal(
    (await callModel({ settings: local, messages: [], dir: await scratch(), key: 'k', send })).ok,
    true,
  );
});

test('the reply is saved verbatim, including an empty or truncated one; no reply saves nothing', async () => {
  const task = await loadTask('spiral-staircase');
  const fenced = '```ts\nexport default () => null;\n```';
  for (const [result, saved] of [
    [{ ok: true, reason: null, source: fenced }, fenced],
    [{ ok: false, reason: 'empty-output', source: '' }, ''],
    [{ ok: false, reason: 'incomplete-output:length', source: 'export default' }, 'export default'],
    [{ ok: false, reason: 'http-500' }, null],
    [{ ok: false, reason: 'served-model-mismatch-or-missing', source: 'code' }, null],
  ]) {
    const dir = await scratch();
    const call = async ({ messages, dir: target }) => {
      assert.deepEqual(messages, requestMessages(task));
      await mkdir(target);
      return result;
    };
    const { replied } = await generateAttempt({ task, settings: routed, dir, call });
    assert.equal(replied, saved !== null, result.reason ?? 'ok');
    const text = await readFile(path.join(dir, 'asset.ts'), 'utf8').catch(() => null);
    assert.equal(text, saved);
  }
});
