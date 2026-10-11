// One model call: the request body, the transport and its retry rule, and the
// reading of the reply. Every call leaves its request, each response and the
// parsed completion in the attempt directory.
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// An OpenAI-compatible server (a lab's own, vLLM, SGLang, ...) has its own key
// variable, so a key set for another service is never sent to it. The key is
// optional, since local servers often need none.
const KEY_ENV = { openrouter: 'OPENROUTER_API_KEY', 'openai-compatible': 'THREEJSBENCH_ENDPOINT_KEY' };
const compatible = settings => settings.api === 'openai-compatible';
const urlOf = settings => (compatible(settings) ? settings.baseUrl + '/chat/completions' : OPENROUTER_URL);
// Finish reasons that mean the model ended its reply. TGI names a natural end eos_token or stop_sequence.
const stops = settings => (compatible(settings) ? ['stop', 'eos_token', 'stop_sequence'] : ['stop']);
const loopback = host => host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
const providerSlug = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** The JSON body sent for `messages` under generation settings (generation.js). */
export function requestBody(settings, messages) {
  if (compatible(settings))
    // A plain Chat Completions request: no routing block and no usage extension.
    return {
      model: settings.model,
      messages,
      max_completion_tokens: settings.maxTokens,
      reasoning_effort: settings.reasoning,
      stream: false,
    };
  return {
    model: settings.model,
    messages,
    max_tokens: settings.maxTokens,
    reasoning: { effort: settings.reasoning },
    provider: {
      ...(settings.provider ? { only: [settings.provider] } : {}),
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
    },
    usage: { include: true },
    stream: false,
  };
}

function transport(body, { url, key, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const request = (new URL(url).protocol === 'http:' ? http : https).request(url, {
      method: 'POST',
      headers: {
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    request.on('error', error => reject(new Error(error.code ?? error.message)));
    request.on('response', response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) request.destroy(new Error('response-byte-limit'));
        else chunks.push(chunk);
      });
      response.on('error', error => reject(new Error(error.code ?? 'response-error')));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
          requestId: response.headers['x-request-id'] ?? null,
        }),
      );
    });
    request.end(body);
  });
}

// OpenRouter reports the cost in USD.
const callCost = usage =>
  typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null;

/** The completion read from a 200 response body: the reply, who served it, and why it failed if it did. */
export function parseCompletion(body, settings) {
  const choice = body.choices?.[0];
  const usage = body.usage ?? null,
    finishReason = choice?.finish_reason ?? null;
  const completion = {
    source: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    completionId: body.id ?? null,
    model: body.model ?? null,
    // OpenRouter names the backend it routed to; another server records its host.
    provider: compatible(settings) ? new URL(settings.baseUrl).host : (body.provider ?? null),
    finishReason,
    usage,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    cost: callCost(usage),
  };
  let reason = null;
  const error = body.error ?? choice?.error;
  if (error) {
    completion.providerError = {
      code: typeof error.code === 'number' || typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message.slice(0, 500) : 'Provider error',
    };
    reason = 'provider-error';
  } else if (
    compatible(settings) &&
    choice &&
    typeof choice.message?.content !== 'string' &&
    typeof finishReason === 'string' &&
    !stops(settings).includes(finishReason)
  )
    // vLLM with a reasoning parser returns no content when the budget runs out
    // mid-reasoning: the model's truncation, not a malformed response.
    reason = 'incomplete-output:' + finishReason;
  else if (!choice || typeof choice.message?.content !== 'string') reason = 'invalid-provider-response';
  else if (!choice.message.content.trim()) reason = 'empty-output';
  else if (
    settings.provider &&
    (typeof completion.provider !== 'string' ||
      providerSlug(completion.provider) !== providerSlug(settings.provider))
  )
    reason = 'served-provider-mismatch-or-missing';
  // An OpenAI-compatible server may name its model differently; the served name is saved, not checked.
  else if (!compatible(settings) && completion.model !== settings.model)
    reason = 'served-model-mismatch-or-missing';
  else if (!stops(settings).includes(finishReason)) reason = 'incomplete-output:' + finishReason;
  return { ...completion, ok: reason === null, reason };
}

const writeJson = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

// Written whole or not at all, so a rerun never reads a partial completion.
async function writeCompletion(dir, value) {
  const file = path.join(dir, 'completion.json');
  await writeJson(file + '.partial', value);
  await rename(file + '.partial', file);
}

/**
 * Sends one request and returns its completion. `dir` must not exist yet: a call
 * the provider may have accepted is never sent again by a rerun. The request is
 * re-sent only when the provider provably did not process it: rate limiting, an
 * unavailable gateway, or a connection that never reached it.
 */
export async function callModel({
  settings,
  messages,
  dir,
  key = process.env[KEY_ENV[settings.api]],
  send = transport,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!key && !compatible(settings)) throw new Error(KEY_ENV[settings.api] + ' is required');
  const url = urlOf(settings),
    target = new URL(url);
  if (key && target.protocol === 'http:' && !loopback(target.hostname))
    throw new Error(
      `Refusing to send ${KEY_ENV[settings.api]} over plain http to ${target.host}; use https or a loopback address`,
    );
  await mkdir(dir);
  const body = requestBody(settings, messages),
    text = JSON.stringify(body),
    requestSha256 = sha256(text),
    calls = [];
  await writeJson(path.join(dir, 'request.json'), body);
  for (let attempt = 1; attempt <= settings.transport.attempts; attempt++) {
    const start = new Date().toISOString(),
      clock = performance.now();
    let response = null,
      error = null;
    try {
      response = await send(text, { url, key, maxResponseBytes: settings.transport.maxResponseBytes });
    } catch (e) {
      error = String(e.message).slice(0, 200);
    }
    const call = {
      attempt,
      start,
      durationMs: Math.round(performance.now() - clock),
      requestSha256,
      status: response?.status ?? null,
      requestId: response?.requestId ?? null,
      transportError: error,
    };
    if (response) {
      await writeFile(path.join(dir, `response-${attempt}.json`), response.text, { flag: 'wx', mode: 0o600 });
      call.responseSha256 = sha256(response.text);
    }
    calls.push(call);
    if (response?.status === 200) {
      let completion;
      try {
        completion = parseCompletion(JSON.parse(response.text), settings);
      } catch {
        completion = { ok: false, reason: 'invalid-provider-json' };
      }
      const result = { ...completion, requestSha256, calls };
      await writeCompletion(dir, result);
      return result;
    }
    const unreached = error !== null && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(error);
    const retryable = unreached || [429, 502, 503, 504].includes(response?.status);
    if (!retryable || attempt === settings.transport.attempts) {
      const result = {
        ok: false,
        reason: error ? 'transport-failure' : 'http-' + response.status,
        requestSha256,
        calls,
      };
      await writeCompletion(dir, result);
      return result;
    }
    await delay(Math.min(5000, 1000 * 2 ** (attempt - 1)));
  }
}
