#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { initBook } from './book.ts';
import { AppError, ensure, integer } from './core.ts';
import { acceptVersion, runChapter, runSummary, status } from './workflow.ts';

const HELP = `sagents-translate init <book> --source <chapters> --from <language> --to <language>
sagents-translate prepare <book> --number <n> [--clean-model <id>] [--extract-model <id>]
sagents-translate chapter <book> --number <n> [--model <id>] [--timeout <seconds>] [--api-max-tokens <n>]
sagents-translate revise <book> --number <n> --notes <feedback.md> [--base <version>] [--model <id>]
                         [--timeout <seconds>] [--api-max-tokens <n>]
sagents-translate accept <book> --number <n> --version <version>
sagents-translate status <book>

Node.js >=24.9.0. Without installation: node src/cli.ts <command> ...
Sources: numbered UTF-8 .txt/.md files, e.g. 001-title.txt. init copies them into the book.
Book-local JSON settings, context and versioned prompt files are editable.
prepare stops after cleanup and context extraction. chapter continues through translation.
All three execution commands accept --model, --clean-model, --extract-model, --timeout, --api-max-tokens.
New books: gpt-6-sol@low cleanup, gpt-6-astra@max extraction, gpt-6-astra@low translation.
No automatic acceptance. No real model calls during init, status or accept.
Diagnostics contain only stage metadata and application error codes.`;

const controller = new AbortController();
const abort = () => {
  if (!controller.signal.aborted) console.error('Cancellation requested. Waiting for the current backend call to settle; no next call will start.');
  controller.abort();
};
process.on('SIGINT', abort); process.on('SIGTERM', abort);
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(HELP);
  else {
    const execution = ['number', 'model', 'clean-model', 'extract-model', 'timeout', 'api-max-tokens'];
    const allowed: Record<string, string[]> = {
      init: ['source', 'from', 'to'], chapter: execution, prepare: execution,
      revise: [...execution, 'notes', 'base'], accept: ['number', 'version'], status: [],
    };
    ensure(command in allowed, 'Unknown command. Run --help.', 'invalid_options');
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args, allowPositionals: true,
      options: Object.fromEntries(allowed[command].map(key => [key, { type: 'string' as const }])) }); }
    catch { throw new AppError('invalid_options', 'Invalid command options. Run --help.'); }
    ensure(parsed.positionals.length === 1, 'Specify exactly one book directory.', 'invalid_options');
    const root = resolve(parsed.positionals[0]), values = parsed.values as Record<string, string | undefined>;
    const required = (name: string): string => { ensure(values[name], `Specify --${name}.`, 'invalid_options'); return values[name]!; };
    const positive = (name: string): number => {
      const text = required(name), n = Number(text);
      ensure(/^\d+$/.test(text) && integer(n, 1), `--${name} must be a positive integer.`, 'invalid_options'); return n;
    };
    if (command === 'init') {
      const book = initBook(root, required('source'), required('from'), required('to'));
      console.log(JSON.stringify({ book: root, chapters: book.chapters.length, schemaVersion: book.schemaVersion }, null, 2));
    } else if (command === 'status') console.log(JSON.stringify(status(root), null, 2));
    else if (command === 'accept') console.log(JSON.stringify(await acceptVersion(root, positive('number'), required('version')), null, 2));
    else {
      const run = await runChapter(root, { number: positive('number'), model: values.model,
        cleanModel: values['clean-model'], extractModel: values['extract-model'], prepareOnly: command === 'prepare',
        ...(command === 'revise' ? { notes: resolve(required('notes')), base: values.base } : {}),
        ...(values.timeout ? { timeoutSeconds: positive('timeout') } : {}),
        ...(values['api-max-tokens'] ? { apiMaxTokens: positive('api-max-tokens') } : {}),
        signal: controller.signal, progress: event => process.stderr.write(`${JSON.stringify(event)}\n`) });
      console.log(JSON.stringify(runSummary(root, run), null, 2));
    }
  }
} catch (error) {
  const safe = error instanceof AppError ? error : new AppError('io_error', 'Operation failed. Check local file permissions and project integrity.');
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = controller.signal.aborted ? 130 : safe.code === 'budget_exceeded' ? 3 : safe.code === 'project_locked' ? 4 : 1;
} finally {
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
