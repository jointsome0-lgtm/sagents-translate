import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { AppError, digest, ensure, filled, hash, integer, object, parseJSON } from './core.ts';

export const CONTRACT = 'sagents-ask/0.4.2';
export const USAGE_KEYS = ['inputTokens', 'cachedInputTokens', 'writtenInputTokens', 'outputTokens', 'reasoningTokens'] as const;
export type Usage = Partial<Record<typeof USAGE_KEYS[number], number | null>> | null;
export type Request = { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; schema?: object };
export type Reply = { status: 'done'; text: string; usage?: Usage; endpoint?: string }
  | { status: 'failed'; reason: string; usage?: Usage };
export interface Backend {
  readonly identity: Record<string, unknown>;
  respond(request: Request, signal?: AbortSignal): Promise<Reply>;
}
export type BackendConfig = { command: string; args: string[]; structuredOutput: boolean };
export type ModelOptions = { model: string; timeoutSeconds: number; apiMaxTokens: number | null };

const REASONS = new Set(['unauthorized', 'budget_exceeded', 'rate_limited', 'model_unavailable', 'provider_failed',
  'invalid_request', 'context_limit', 'output_limit', 'incomplete_stream', 'invalid_stream', 'invalid_response',
  'empty_response', 'declined', 'wrong_model', 'unexpected_tools', 'timeout', 'cancelled', 'storage_failed', 'internal_error']);
const MAX_BYTES = 16_000_000;

function usageOf(value: unknown): Usage | undefined {
  if (value === undefined || value === null) return value;
  ensure(object(value), 'Invalid backend usage.', 'invalid_backend_response');
  const usage: Exclude<Usage, null> = {};
  for (const key of USAGE_KEYS) {
    if (value[key] !== undefined) {
      ensure(value[key] === null || integer(value[key]), 'Invalid backend token count.', 'invalid_backend_response');
      usage[key] = value[key] as number | null;
    }
  }
  return usage;
}

export function parseReply(text: string, exitCode: number | null): Reply {
  const value = parseJSON(text, 'Backend did not return one complete JSON response.', 'invalid_backend_response');
  ensure(object(value), 'Invalid backend envelope.', 'invalid_backend_response');
  const usage = usageOf(value.usage);
  const optional = usage === undefined ? {} : { usage };
  if (value.status === 'failed') {
    ensure(typeof value.reason === 'string' && REASONS.has(value.reason), 'Unknown backend failure.', 'invalid_backend_response');
    return { status: 'failed', reason: value.reason, ...optional };
  }
  ensure(value.status === 'done' && filled(value.text) && exitCode === 0, 'Invalid or incomplete backend result.', 'invalid_backend_response');
  const endpoint = typeof value.endpoint === 'string' && /^[A-Za-z0-9 ./_-]{1,40}$/.test(value.endpoint) ? value.endpoint : undefined;
  return { status: 'done', text: value.text, ...optional, ...(endpoint ? { endpoint } : {}) };
}

function executable(command: string): string {
  const candidates = isAbsolute(command) || command.includes('/') ? [resolve(command)]
    : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch { /* next PATH entry */ }
  }
  throw new AppError('backend_not_found', 'Backend executable not found. Install sagents or configure backend.command.');
}

export function createSagentsBackend(config: BackendConfig, options: ModelOptions): Backend {
  const command = executable(config.command);
  const env = { ...process.env };
  const api = options.model.startsWith('api:');
  ensure(api || options.apiMaxTokens === null, '--api-max-tokens applies only to api: models.', 'invalid_options');
  if (options.apiMaxTokens !== null) env.SAGENTS_API_MAX_TOKENS = String(options.apiMaxTokens);
  if (api) {
    const maximum = env.SAGENTS_API_MAX_TOKENS || '2048';
    ensure(/^\d+$/.test(maximum) && integer(Number(maximum), 1), 'Invalid SAGENTS_API_MAX_TOKENS.', 'invalid_options');
    ensure(['', '1'].includes(env.SAGENTS_API_STREAM ?? ''), 'Invalid SAGENTS_API_STREAM.', 'invalid_options');
    ensure(!env.SAGENTS_API_CACHE_FIELD || /^[a-z][a-z0-9_]{0,39}$/.test(env.SAGENTS_API_CACHE_FIELD), 'Invalid SAGENTS_API_CACHE_FIELD.', 'invalid_options');
  }
  // Keep credentials out of identity and project files. Hash potentially private server/body settings.
  const apiSettings = api ? {
    maxTokens: env.SAGENTS_API_MAX_TOKENS || '2048',
    endpointHash: hash(env.SAGENTS_API_URL ?? ''), extraHash: hash(env.SAGENTS_API_EXTRA ?? ''),
    stream: env.SAGENTS_API_STREAM ?? '', cacheField: env.SAGENTS_API_CACHE_FIELD ?? '',
  } : null;
  const identity = { adapter: CONTRACT, command, commandHash: hash(readFileSync(command)), args: config.args,
    structuredOutput: config.structuredOutput, model: options.model, timeoutSeconds: options.timeoutSeconds, apiSettings };
  return {
    identity,
    async respond(request, signal) {
      if (signal?.aborted) return { status: 'failed', reason: 'cancelled' };
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > MAX_BYTES) return { status: 'failed', reason: 'request_limit' };
      return new Promise<Reply>(resolveReply => {
        const child = spawn(command, [...config.args, 'ask', '--timeout', String(options.timeoutSeconds)], {
          shell: false, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        });
        const chunks: Buffer[] = [];
        let size = 0, stopped: string | undefined, force: NodeJS.Timeout | undefined;
        const terminate = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch { /* already exited */ }
        };
        const stop = (reason: string) => {
          stopped ??= reason; terminate('SIGTERM');
          force ??= setTimeout(() => terminate('SIGKILL'), 2000);
        };
        // The separate process group keeps terminal Ctrl+C from interrupting renewal.
        // ask has no cooperative cancellation input. Let it settle after Ctrl+C,
        // including credential renewal; the workflow will make no following call.
        // sagents may finish token renewal up to 120 s after its own timeout.
        const timer = setTimeout(() => stop('timeout'), (options.timeoutSeconds + 125) * 1000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) stop('invalid_backend_response');
          else chunks.push(chunk);
        });
        // stderr can contain provider text or secrets: drain, never persist or print it.
        child.stderr.resume();
        child.stdin.on('error', () => { /* close/exit determines whether stdout is usable */ });
        child.on('error', () => { stopped ??= 'backend_start_failed'; });
        child.on('close', code => {
          clearTimeout(timer); if (force) clearTimeout(force);
          if (stopped) { resolveReply({ status: 'failed', reason: stopped }); return; }
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            resolveReply(parseReply(text, code));
          } catch { resolveReply({ status: 'failed', reason: 'invalid_backend_response' }); }
        });
        child.stdin.end(body);
      });
    },
  };
}

export function usageSummary(attempts: { usage?: Usage }[]) {
  return Object.fromEntries(USAGE_KEYS.map(key => {
    const reported = attempts.flatMap(a => typeof a.usage?.[key] === 'number' ? [a.usage[key] as number] : []);
    return [key, { knownTotal: reported.length ? reported.reduce((a, b) => a + b, 0) : null,
      reportedCalls: reported.length, unknownCalls: attempts.length - reported.length }];
  }));
}

export const requestHash = (request: Request): string => digest(request);
