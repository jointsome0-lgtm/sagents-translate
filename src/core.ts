import { createHash } from 'node:crypto';

// Only messages authored by this application may reach diagnostics.
export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function ensure(condition: unknown, message: string, code = 'invalid_project'): asserts condition {
  if (!condition) throw new AppError(code, message);
}

export const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
export const filled = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export const integer = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number =>
  Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
export const errno = (x: unknown): string | undefined => (x as NodeJS.ErrnoException | null)?.code;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const digest = (value: unknown): string => hash(canonical(value));
export const now = (): string => new Date().toISOString();
export const chapterName = (n: number): string => String(n).padStart(4, '0');

export function parseJSON(text: string, message: string, code = 'invalid_project'): unknown {
  try { return JSON.parse(text); } catch { throw new AppError(code, message); }
}
