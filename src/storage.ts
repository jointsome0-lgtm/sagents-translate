import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, errno, parseJSON } from './core.ts';

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}

export const writeJSON = (path: string, value: unknown): void => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
// The first line is created with atomicWrite; later records remain readable after a crash (ignore an unfinished final line).
export const appendJSON = (path: string, value: unknown): void => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flush: true });

export function readText(path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)); }
  catch { throw new AppError('unreadable_file', 'Cannot read a required UTF-8 project file. Check the project paths and permissions.'); }
}

export const readJSON = (path: string): unknown => parseJSON(readText(path).replace(/^\uFEFF/, ''), 'A project JSON file is invalid.');

// SQLite is used only as an OS-released advisory lock. Book data remains JSON/text.
// Never delete this file: replacing its inode would allow two independent locks.
export async function withBookLock<T>(root: string, action: () => Promise<T> | T): Promise<T> {
  if (!existsSync(join(root, 'book.json'))) throw new AppError('invalid_project', 'No book.json at the project path.');
  const path = join(root, '.write-lock.sqlite');
  try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
  catch (error) { if (errno(error) !== 'EEXIST') throw error; }
  const db = new DatabaseSync(path);
  try {
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { throw new AppError('project_locked', 'Another process is writing this book. Retry after it finishes. Do not delete the lock file.'); }
    return await action();
  } finally { db.close(); }
}
