import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isObject } from './jev.js';
import type { BridgeConfig, Provider } from './types.js';

export interface ServerConfig extends BridgeConfig { port: number; host: string }
function number(value: unknown, fallback: number, name: string, minimum: number, integer = true): number {
  const result = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || integer && !Number.isInteger(result)) throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${minimum}`);
  return result;
}
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw: unknown = parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  if (!isObject(raw) || !isObject(raw.providers) || !Object.keys(raw.providers).length) throw new Error('config.yaml: no providers configured');
  const globals = isObject(raw.globals) ? raw.globals : {};
  const providers: Record<string, Provider> = Object.create(null);
  for (const [name, value] of Object.entries(raw.providers)) {
    if (!isObject(value)) throw new Error(`provider '${name}' must be an object`);
    const kind = value.kind || 'chat';
    if (kind !== 'chat' && kind !== 'jev') throw new Error(`provider '${name}' has unknown kind '${kind}'`);
    if (typeof value.base_url !== 'string' || !/^https?:\/\//.test(value.base_url)) throw new Error(`provider '${name}' needs an http(s) base_url`);
    if (value.model != null && typeof value.model !== 'string') throw new Error(`provider '${name}' model must be a string`);
    providers[name] = {
      name, kind, baseUrl: value.base_url, model: value.model || '',
      apiKey: typeof value.api_key_env === 'string' ? env[value.api_key_env] || '' : '',
      apiKeyEnv: typeof value.api_key_env === 'string' ? value.api_key_env : undefined,
      topk: value.topk == null ? undefined : number(value.topk, 20, `${name}.topk`, 1),
      extraBody: isObject(value.extra_body) ? value.extra_body : {},
    };
  }
  const active = env.LOGJEV_ACTIVE || env.OPENJEV_ACTIVE || raw.active;
  if (typeof active !== 'string' || !Object.hasOwn(providers, active)) throw new Error('active provider is missing from providers');
  const promptMode = env.PROMPT_MODE || globals.prompt_mode || 'full';
  if (promptMode !== 'full' && promptMode !== 'minimal') throw new Error('prompt_mode must be full|minimal');
  const retryDelays = globals.retry_delays_ms ?? [800, 2000, 5000];
  if (!Array.isArray(retryDelays)) throw new Error('retry_delays_ms must be an array');
  const cors = globals.cors_origins ?? ['*'];
  if (!Array.isArray(cors) || !cors.every(origin => typeof origin === 'string')) throw new Error('cors_origins must be a string array');
  const port = number(env.PORT || globals.port, 8013, 'port', 0);
  if (port > 65535) throw new Error('port must be <= 65535');
  return {
    active, providers, promptMode, port, host: env.HOST || '127.0.0.1',
    bridgeApiKey: env.BRIDGE_API_KEY || '',
    readTemperature: number(globals.read_temperature, 1, 'read_temperature', 0, false),
    topk: number(globals.topk, 20, 'topk', 1),
    concurrency: number(globals.concurrency, 4, 'concurrency', 1),
    retryDelaysMs: retryDelays.map(delay => number(delay, 0, 'retry delay', 0)),
    timeoutMs: number(globals.timeout_ms, 60_000, 'timeout_ms', 1),
    corsOrigins: cors as string[],
  };
}
