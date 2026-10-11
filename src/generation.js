// How an attempt is generated: one request, one reply, no tools and no repair
// turn. Every model is asked the same request (prompt.js) at high reasoning
// with the same token budget. The settings are written beside the attempts
// they produced.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROMPT_SHA256, requestMessages } from './prompt.js';
import { callModel } from './model-call.js';

/** An OpenAI-compatible server's base URL, such as https://host/v1: http(s), no credentials, query or fragment. */
function validBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value))
    throw new Error('--base-url must be an http(s) URL without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}

/**
 * The settings for one model. Through OpenRouter (the default), `provider`
 * requires one backend, so every attempt of a model is served by the same one;
 * otherwise OpenRouter chooses per request. With `baseUrl`, the request goes
 * directly to an OpenAI-compatible server.
 */
export function generationSettings({ model, provider = null, baseUrl = null }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('--model is required');
  if (baseUrl !== null && provider !== null) throw new Error('--provider applies only to OpenRouter');
  if (provider !== null && !/^[a-z0-9][a-z0-9-]*$/.test(provider))
    throw new Error('--provider must be an OpenRouter provider slug');
  return {
    model,
    api: baseUrl !== null ? 'openai-compatible' : 'openrouter',
    ...(baseUrl !== null ? { baseUrl: validBaseUrl(baseUrl) } : {}),
    ...(provider !== null ? { provider } : {}),
    reasoning: 'high',
    maxTokens: 64_000,
    promptSha256: PROMPT_SHA256,
    // No local deadline: a request that timed out may still have been billed.
    transport: { attempts: 3, maxResponseBytes: 8 * 1024 * 1024 },
  };
}

// Failures that are the model's own: it replied with nothing, or its reply was
// cut off. Its reply is still the attempt. Any other failure produced no reply.
const isModelFailure = reason => reason === 'empty-output' || String(reason).startsWith('incomplete-output:');

/** Saves a completion's reply verbatim as asset.ts, unless it is already saved. */
async function saveReply(dir, completion) {
  const replied = completion.ok || isModelFailure(completion.reason);
  if (replied)
    await writeFile(path.join(dir, 'asset.ts'), completion.source ?? '', { flag: 'wx', mode: 0o600 }).catch(
      error => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
  return { replied, reason: completion.reason };
}

/** Generates one attempt into `dir`, which must not exist yet. */
export async function generateAttempt({ task, settings, dir, call = callModel }) {
  return saveReply(dir, await call({ settings, messages: requestMessages(task), dir }));
}

/**
 * An attempt a previous run finished in `dir`, read from its saved files without
 * sending anything; null if it has no completion. A reply a run saved in
 * completion.json but was stopped before writing to asset.ts is written now. An
 * attempt sent with a different request, such as an edited brief, is refused.
 */
export async function savedAttempt({ task, dir }) {
  let completion;
  try {
    completion = JSON.parse(await readFile(path.join(dir, 'completion.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const request = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8'));
  if (JSON.stringify(request.messages) !== JSON.stringify(requestMessages(task)))
    throw new Error(`${dir} was sent a different request; use another --out`);
  return saveReply(dir, completion);
}
