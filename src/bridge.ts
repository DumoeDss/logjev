import { answerFor, buildPrompt, isObject, normalizeQuestion, parseTopLogprobs, QuestionError } from './jev.js';
import type { BridgeConfig, BridgeOptions, Json, JsonObject, Message, PromptMode, Provider, Question } from './types.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
class UpstreamError extends Error {}
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
type ReadUsage = { prompt_tokens: number; completion_tokens: number };
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

function validContent(value: Json | undefined): boolean {
  return typeof value === 'string' || Array.isArray(value) && value.length > 0 && value.every(part => isObject(part) && (
    part.type === 'text' && typeof part.text === 'string' ||
    part.type === 'image_url' && isObject(part.image_url) && typeof part.image_url.url === 'string' ||
    part.type === 'audio_url' && isObject(part.audio_url) &&
      typeof part.audio_url.url === 'string' && part.audio_url.url.trim().length > 0 ||
    part.type === 'input_audio' && isObject(part.input_audio) &&
      typeof part.input_audio.data === 'string' && part.input_audio.data.trim().length > 0 &&
      typeof part.input_audio.format === 'string' && part.input_audio.format.trim().length > 0
  ));
}

/** Fetch-standard handler; the core has no Node imports or filesystem dependency. */
export function createBridge(config: BridgeConfig, options: BridgeOptions = {}) {
  if (!Object.hasOwn(config.providers, config.active)) throw new Error('active provider is missing from providers');
  const concurrency = config.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const upstreamFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delays = config.retryDelaysMs ?? [800, 2000, 5000];
  const timeout = config.timeoutMs ?? 60_000;
  let running = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
    else running++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else running--; }
  }
  const visibleProviders = () => Object.values(config.providers).map(({ name, kind, model }) => ({ name, kind, model }));
  function requireProviderKey(provider: Provider): void {
    if (provider.apiKeyEnv && !provider.apiKey?.trim()) {
      throw new HttpError(503, `provider '${provider.name}' is missing ${provider.apiKeyEnv}. Set it in the environment or in .env beside the selected config.yaml, then restart LogJev.`);
    }
  }
  function headers(provider: Provider): Record<string, string> {
    return { 'Content-Type': 'application/json', Accept: 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) };
  }
  function errorMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const provider of Object.values(config.providers)) if (provider.apiKey) message = message.replaceAll(provider.apiKey, '[redacted]');
    return message;
  }
  async function post(url: string, body: JsonObject, provider: Provider): Promise<JsonObject> {
    let status = 0, detail = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const response = await upstreamFetch(url, { method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        status = response.status;
        if (status === 200) {
          let data: unknown;
          try { data = await response.json(); }
          catch { throw new UpstreamError('upstream returned invalid JSON'); }
          if (!isObject(data)) throw new UpstreamError('upstream returned a non-object response');
          return data;
        }
        detail = (await response.text()).slice(0, 300);
        if (!RETRY_STATUS.has(status)) break;
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        status = 0; detail = errorMessage(error);
      }
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
    throw new UpstreamError(`upstream call failed (${status}): ${detail}`);
  }
  async function read(messages: Message[], model: string, provider: Provider): Promise<[Record<string, number>, ReadUsage]> {
    const body: JsonObject = {
      ...provider.extraBody, model, messages,
      max_tokens: 1, temperature: config.readTemperature ?? 1,
      logprobs: true, top_logprobs: provider.topk ?? config.topk ?? 20,
    };
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let choice: Json = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = await post(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', body, provider);
      choice = Array.isArray(data.choices) ? data.choices[0] ?? {} : {};
      const rawUsage = isObject(data.usage) ? data.usage : {};
      usage.prompt_tokens += tokenCount(rawUsage.prompt_tokens);
      usage.completion_tokens += tokenCount(rawUsage.completion_tokens);
      const top = parseTopLogprobs(choice);
      if (top) return [top, usage];
    }
    throw new UpstreamError('upstream returned no top_logprobs — the bridge needs an OpenAI-compatible chat upstream that returns logprobs (choices[0] keys: ' + (isObject(choice) ? Object.keys(choice).join(',') : '') + ')');
  }
  async function answerOne(state: Json | undefined, question: Question, model: string, provider: Provider, history: Message[] | null, mode: PromptMode) {
    const [messages, labels] = buildPrompt(state, question, history, mode);
    return limited(async () => {
      let [top, usage] = await read(messages, model, provider);
      if (!labels.some(label => Object.hasOwn(top, label))) {
        const [firmMessages] = buildPrompt(state, question, history, mode, true);
        const [retryTop, retryUsage] = await read(firmMessages, model, provider);
        usage = { prompt_tokens: usage.prompt_tokens + retryUsage.prompt_tokens, completion_tokens: usage.completion_tokens + retryUsage.completion_tokens };
        if (labels.some(label => Object.hasOwn(retryTop, label))) top = retryTop;
      }
      return { answer: answerFor(question, labels, top), usage };
    });
  }
  async function systemone(request: Request): Promise<JsonObject> {
    if (config.bridgeApiKey && request.headers.get('Authorization') !== `Bearer ${config.bridgeApiKey}`) throw new HttpError(401, 'invalid bridge api key');
    let body: unknown;
    try { body = await request.json(); } catch { throw new HttpError(422, 'body must be JSON'); }
    if (!isObject(body)) throw new HttpError(422, 'body must be an object');
    const providerName = body.provider || config.active;
    if (typeof providerName !== 'string' || !Object.hasOwn(config.providers, providerName)) throw new HttpError(422, `unknown provider ${JSON.stringify(providerName)} — configured: ${Object.keys(config.providers).sort().join(', ')}`);
    const provider = config.providers[providerName];
    const model = !body.model || body.model === 'jev-latest' ? provider.model : body.model;
    if (typeof model !== 'string' || !model) throw new HttpError(422, `provider '${provider.name}' needs a default model in config.yaml or a string model in the request`);
    const state = body.state;
    const messages = body.messages;
    if (state != null && messages != null) throw new HttpError(422, 'provide either state or messages, not both');
    let history: Message[] | null = null;
    if (messages != null) {
      if (!Array.isArray(messages) || !messages.length) throw new HttpError(422, 'messages must be a non-empty array');
      history = messages.map((item, i) => {
        if (!isObject(item) || !['system', 'user', 'assistant'].includes(String(item.role)) || !validContent(item.content)) throw new HttpError(422, `messages[${i}] must be {role: system|user|assistant, content: string or [text/image_url/input_audio/audio_url parts] (input_audio needs non-empty data and format; audio_url needs a non-empty url)}`);
        return { role: item.role, content: item.content } as Message;
      });
    }
    if (!isObject(body.questions) || !Object.keys(body.questions).length) throw new HttpError(422, 'questions must be a non-empty object');
    requireProviderKey(provider);
    const started = performance.now();
    if (provider.kind === 'jev') {
      const payload: JsonObject = { model, questions: body.questions };
      if (messages != null) payload.messages = messages;
      else if (state != null) payload.state = state;
      const data = await post(provider.baseUrl, payload, provider);
      if (!Object.hasOwn(data, 'answers')) throw new UpstreamError(`jev passthrough: unexpected response shape (keys: ${Object.keys(data).join(',')})`);
      return { ...data, model, usage: data.usage ?? {}, latency_ms: Math.round(performance.now() - started) };
    }
    const mode = body.prompt_mode || config.promptMode || 'full';
    if (mode !== 'minimal' && mode !== 'full') throw new HttpError(422, "prompt_mode must be one of ('minimal', 'full')");
    const questions = Object.entries(body.questions).map(([id, raw]) => [id, normalizeQuestion(id, raw)] as const);
    const results = await Promise.allSettled(questions.map(([, question]) => answerOne(state, question, model, provider, history, mode)));
    const answers: JsonObject = Object.create(null);
    const usage = { input_tokens: 0, output_tokens: 0, reads: questions.length };
    results.forEach((result, i) => {
      const id = questions[i][0];
      if (result.status === 'rejected') throw new UpstreamError(`question '${id}': ${errorMessage(result.reason)}`);
      answers[id] = result.value.answer;
      usage.input_tokens += result.value.usage.prompt_tokens;
      usage.output_tokens += result.value.usage.completion_tokens;
    });
    return { model, answers, usage, latency_ms: Math.round(performance.now() - started) };
  }
  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
    const provider = config.providers[config.active];
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method === 'POST' && path === '/v1/systemone') return Response.json(await systemone(request));
    if (request.method === 'GET' && path === '/v1/providers') return Response.json({ active: config.active, providers: visibleProviders() });
    if (request.method === 'GET' && path === '/health') return Response.json({ ok: true, upstream: provider.baseUrl, model: provider.model, active: config.active, providers: visibleProviders() });
    if (request.method === 'GET' && path === '/v1/models') {
      if (provider.kind === 'jev') return Response.json({ data: [{ id: provider.model, object: 'model' }] });
      requireProviderKey(provider);
      let data: unknown;
      try {
        const response = await upstreamFetch(provider.baseUrl.replace(/\/+$/, '') + '/models', { headers: headers(provider), signal: AbortSignal.timeout(timeout) });
        if (response.status !== 200) throw new Error(`upstream /models → ${response.status}: ${(await response.text()).slice(0, 200)}`);
        data = await response.json();
      } catch (error) { throw new HttpError(502, errorMessage(error)); }
      if (!isObject(data) || !Array.isArray(data.data)) throw new HttpError(502, 'upstream /models returned an invalid model list');
      const ids = data.data.filter(isObject).map(item => item.id).filter((id): id is string => typeof id === 'string' && !!id);
      ids.sort((a, b) => a === b ? 0 : a === provider.model ? -1 : b === provider.model ? 1 : a < b ? -1 : 1);
      return Response.json({ data: ids.map(id => ({ id, object: 'model' })) });
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  }
  return async (request: Request): Promise<Response> => {
    let response: Response;
    try { response = await route(request); }
    catch (error) {
      response = error instanceof HttpError ? Response.json({ detail: error.message }, { status: error.status })
        : error instanceof QuestionError ? Response.json({ detail: error.message }, { status: 422 })
        : Response.json({ error: { message: errorMessage(error), type: 'upstream' } }, { status: 502 });
    }
    const origins = config.corsOrigins ?? ['*'];
    const origin = request.headers.get('Origin');
    if (origins.includes('*') || origin && origins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin!);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    response.headers.set('Vary', 'Origin');
    return response;
  };
}
