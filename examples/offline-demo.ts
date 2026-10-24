// Reproducible synthetic example: only the local fixture backend is invoked.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBook } from '../src/book.ts';
import { AppError } from '../src/core.ts';
import { atomicWrite, writeJSON } from '../src/storage.ts';
import { acceptVersion, runChapter, status } from '../src/workflow.ts';

const root = resolve(process.argv[2] ?? 'books/demo');
try {
  const book = initBook(root, fileURLToPath(new URL('./synthetic/', import.meta.url)), 'zh', 'ru');
  const control = join(root, 'fake-backend.json');
  writeJSON(control, {});
  book.backend.command = process.execPath;
  book.backend.args = [fileURLToPath(new URL('../test/fixtures/fake-sagents.ts', import.meta.url)), control];
  book.settings.model = 'fixture-model';
  book.settings.cleanModel = 'fixture-clean'; book.settings.extractModel = 'fixture-extract';
  writeJSON(join(root, 'book.json'), book);
  const first = await runChapter(root, { number: 1 });
  await acceptVersion(root, 1, first.version);
  const feedback = join(root, 'feedback.md');
  atomicWrite(feedback, 'Сделать интонацию реплики яснее, сохранив отрицание.\n');
  await runChapter(root, { number: 1, notes: feedback });
  console.log(JSON.stringify(status(root), null, 2));
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'Offline demo failed. Check file permissions.');
  process.exitCode = 1;
}
