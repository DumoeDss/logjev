export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type PromptMode = 'minimal' | 'full';
export type Message = { role: 'system' | 'user' | 'assistant'; content: string | JsonObject[] };
export type Question =
  | { type: 'choice'; instructions: string; keys: string[]; criteria: JsonObject }
  | { type: 'score'; instructions: string; levels: string[] }
  | { type: 'noul'; instructions: string };
export type Answer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };
export interface Provider {
  name: string;
  kind: 'chat' | 'jev';
  baseUrl: string;
  apiKey?: string;
  /** Configured credential variable; when present, this provider requires a key. */
  apiKeyEnv?: string;
  model: string;
  topk?: number;
  extraBody?: JsonObject;
}
export interface BridgeConfig {
  active: string;
  providers: Record<string, Provider>;
  bridgeApiKey?: string;
  promptMode?: PromptMode;
  readTemperature?: number;
  topk?: number;
  retryDelaysMs?: number[];
  concurrency?: number;
  corsOrigins?: string[];
  timeoutMs?: number;
}
export interface BridgeOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}
