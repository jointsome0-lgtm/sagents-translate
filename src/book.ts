import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from './backend.ts';
import { AppError, chapterName, digest, ensure, filled, hash, integer, object } from './core.ts';
import { atomicWrite, readJSON, readText, syncDirectory, writeJSON } from './storage.ts';
import { ALL_STAGES, sourceUnits } from './outputs.ts';
import type { Stage } from './outputs.ts';

export const WORKFLOW = 'chapter/2';
export type Book = {
  schemaVersion: 1; from: string; to: string;
  chapters: { number: number; file: string }[];
  backend: BackendConfig;
  settings: { model: string | null; cleanModel?: string; extractModel?: string; timeoutSeconds: number; apiMaxTokens: number | null; retries: number; maxParts: number };
};
type Scope = { id: string; fromChapter: number; toChapter: number | null };
export type GlossaryEntry = Scope & { source: string; target: string; aliases: string[]; notes: string };
export type ContextEntry = Scope & { kind: string; text: string; character: string | null; match: string[] };
export type Context = { glossaryVersion: string; notesVersion: string; glossary: GlossaryEntry[]; notes: ContextEntry[] };
export type Prompts = { version: string; rules: string; stages: Record<Stage, string> };
export type Material = { source: string; sourceHash: string; context: Context; contextHash: string; prompts: Prompts; promptsHash: string; from: string; to: string };
export const NOTE_TYPES = ['style', 'address', 'plot_fact', 'character_knowledge', 'character_belief', 'interpretation', 'question', 'source_issue', 'user_note'];
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(filled);
export const validModel = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:/_.@+\-]{0,199}$/.test(v);

export function readBook(root: string): Book {
  const v = readJSON(join(root, 'book.json'));
  ensure(object(v) && v.schemaVersion === 1, 'Unsupported or invalid book schema.');
  ensure(filled(v.from) && filled(v.to), 'Book languages must be nonempty strings.');
  ensure(Array.isArray(v.chapters) && v.chapters.length > 0, 'Book has no chapter map.');
  const numbers = new Set<number>();
  for (const c of v.chapters) {
    ensure(object(c) && integer(c.number, 1) && typeof c.file === 'string' && /^sources\/\d+\.(txt|md)$/.test(c.file), 'Invalid chapter map.');
    ensure(!numbers.has(c.number), 'Duplicate chapter number.'); numbers.add(c.number);
  }
  const b = v.backend, s = v.settings;
  ensure(object(b) && filled(b.command) && Array.isArray(b.args) && b.args.every(a => typeof a === 'string')
    && typeof b.structuredOutput === 'boolean', 'Invalid backend configuration.');
  ensure(object(s) && (s.model === null || validModel(s.model)) && integer(s.timeoutSeconds, 1, 3600)
    && (s.apiMaxTokens === null || integer(s.apiMaxTokens, 1)) && integer(s.retries, 0, 2) && integer(s.maxParts, 1, 64), 'Invalid execution settings.');
  ensure(['cleanModel', 'extractModel'].every(k => s[k] === undefined || validModel(s[k])), 'Invalid preparation model.');
  return v as unknown as Book;
}

function entries(path: string): { version: string; entries: Record<string, unknown>[] } {
  const v = readJSON(path);
  ensure(object(v) && v.schemaVersion === 1 && filled(v.version) && Array.isArray(v.entries), 'Invalid context file.');
  const ids = new Set<string>();
  for (const entry of v.entries) {
    ensure(object(entry) && filled(entry.id) && integer(entry.fromChapter, 1)
      && (entry.toChapter === null || integer(entry.toChapter, entry.fromChapter)), 'Context entries require id, fromChapter and toChapter.');
    ensure(!ids.has(entry.id), 'Duplicate context id.'); ids.add(entry.id);
  }
  return v as unknown as { version: string; entries: Record<string, unknown>[] };
}

export function readContext(root: string, number: number, source: string): Context {
  const glossary = entries(join(root, 'context', 'glossary.json'));
  const notes = entries(join(root, 'context', 'notes.json'));
  for (const e of glossary.entries) ensure(filled(e.source) && filled(e.target) && strings(e.aliases) && typeof e.notes === 'string', 'Invalid glossary entry.');
  for (const e of notes.entries) ensure(NOTE_TYPES.includes(e.kind as string) && filled(e.text) && strings(e.match)
    && (e.character === null || filled(e.character)), 'Invalid context note.');
  const eligible = (e: Record<string, unknown>) => (e.fromChapter as number) <= number && (e.toChapter === null || number <= (e.toChapter as number));
  const mentions = (words: string[]) => words.some(w => source.toLowerCase().includes(w.toLowerCase()));
  return {
    glossaryVersion: glossary.version, notesVersion: notes.version,
    glossary: glossary.entries.filter(e => eligible(e) && mentions([e.source as string, ...e.aliases as string[]])) as GlossaryEntry[],
    notes: notes.entries.filter(e => eligible(e) && (!(e.match as string[]).length || mentions(e.match as string[]))) as ContextEntry[],
  };
}

export function readPrompts(root: string): Prompts {
  const manifest = readJSON(join(root, 'prompts', 'manifest.json'));
  ensure(object(manifest) && manifest.schemaVersion === 1 && filled(manifest.version), 'Invalid prompt manifest.');
  const rules = readText(join(root, 'prompts', 'rules.md'));
  const stages = Object.fromEntries(ALL_STAGES.map(stage => {
    const local = join(root, 'prompts', `${stage}.md`);
    // Existing books keep their editable translation prompts; only new preparation files have a fallback.
    const path = !existsSync(local) && (stage === 'clean' || stage === 'extract')
      ? fileURLToPath(new URL(`../templates/prompts/${stage}.md`, import.meta.url)) : local;
    return [stage, readText(path)];
  })) as Record<Stage, string>;
  ensure(filled(rules) && Object.values(stages).every(filled), 'Prompt files must not be empty.');
  return { version: manifest.version, rules, stages };
}

export function materialFor(root: string, number: number): { book: Book; material: Material } {
  const book = readBook(root), chapter = book.chapters.find(c => c.number === number);
  ensure(chapter, 'Chapter number not found.', 'chapter_not_found');
  const source = readText(join(root, chapter.file));
  ensure(sourceUnits(source).length > 0, 'Chapter source is empty.', 'empty_source');
  const context = readContext(root, number, source), prompts = readPrompts(root);
  return { book, material: { source, sourceHash: hash(source), context, contextHash: digest(context), prompts, promptsHash: digest(prompts), from: book.from, to: book.to } };
}

export function initBook(rootPath: string, sourcePath: string, from: string, to: string): Book {
  const root = resolve(rootPath), source = resolve(sourcePath);
  ensure(filled(from) && filled(to), 'Specify --from and --to.', 'invalid_options');
  ensure(!existsSync(root), 'Destination already exists; choose a new book directory.', 'destination_exists');
  const chapters: Book['chapters'] = [];
  const contents = new Map<string, string>();
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.(txt|md)$/i.test(entry.name)) continue;
    const match = /^(\d+)(?:[ ._-].*)?\.(txt|md)$/i.exec(entry.name);
    ensure(match, 'TXT/Markdown chapter filenames must start with a number, e.g. 001-title.txt.', 'invalid_source');
    const number = Number(match[1]);
    ensure(integer(number, 1) && !chapters.some(c => c.number === number), 'Invalid or duplicate source chapter number.', 'invalid_source');
    const text = readText(join(source, entry.name));
    ensure(sourceUnits(text).length > 0, 'A source chapter is empty.', 'invalid_source');
    const file = `sources/${chapterName(number)}.${match[2].toLowerCase()}`;
    chapters.push({ number, file }); contents.set(file, text);
  }
  ensure(chapters.length > 0, 'No numbered TXT/Markdown source files found.', 'invalid_source');
  chapters.sort((a, b) => a.number - b.number);
  const book: Book = { schemaVersion: 1, from, to, chapters,
    backend: { command: 'sagents', args: [], structuredOutput: true },
    settings: { model: 'gpt-6-astra@low', cleanModel: 'gpt-6-sol@low', extractModel: 'gpt-6-astra@max',
      timeoutSeconds: 600, apiMaxTokens: null, retries: 0, maxParts: 8 } };
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(root), '.sagents-translate-init-'));
  try {
    atomicWrite(join(temporary, '.gitignore'), '*\n');
    for (const [file, text] of contents) atomicWrite(join(temporary, file), text);
    writeJSON(join(temporary, 'context', 'glossary.json'), { schemaVersion: 1, version: '1', entries: [] });
    writeJSON(join(temporary, 'context', 'notes.json'), { schemaVersion: 1, version: '1', entries: [] });
    const templates = fileURLToPath(new URL('../templates/prompts/', import.meta.url));
    for (const file of ['manifest.json', 'rules.md', ...ALL_STAGES.map(s => `${s}.md`)]) atomicWrite(join(temporary, 'prompts', file), readText(join(templates, file)));
    writeJSON(join(temporary, 'book.json'), book);
    // Each competing init renames a fully populated directory. Neither can replace the other.
    renameSync(temporary, root); syncDirectory(dirname(root));
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(root)) throw new AppError('destination_exists', 'Destination was created by another process.');
    throw error;
  }
  return book;
}
