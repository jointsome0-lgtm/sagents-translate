import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// Only public CLI behavior and files a reader uses; no assertions about internal checkpoints.
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-sagents.ts', import.meta.url));
const source = fileURLToPath(new URL('../examples/synthetic/', import.meta.url));
const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

function start(args: string[]) {
  const process = spawn(globalThis.process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
    process.on('close', code => resolve({ code, stdout, stderr })));
  return { process, done };
}

function setup(t: TestContext, mode: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sagents-translate-test-')), root = join(dir, 'book'), control = join(dir, 'control.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = spawnSync(process.execPath, [cli, 'init', root, '--source', source, '--from', 'zh', '--to', 'ru'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const book = json(join(root, 'book.json'));
  book.backend = { command: process.execPath, args: [fixture, control], structuredOutput: true };
  book.settings.model = 'fixture-model';
  write(join(root, 'book.json'), book); write(control, mode);
  const calls = (): { stage: string; pid: number }[] => existsSync(`${control}.calls`) ? read(`${control}.calls`).trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const args = ['chapter', root, '--number', '1'];
  const run = async (commandArgs = args, expected = 0) => {
    const result = await start(commandArgs).done;
    assert.equal(result.code, expected, result.stderr);
    return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
  };
  return { root, dir, control, book, calls, args, run };
}

test('chapter, acceptance and revision preserve accepted text; changed source creates a fresh version', async t => {
  const f = setup(t, { forbid: ['FUTURE_SECRET'], remainingIssue: true });
  write(join(f.root, 'context', 'notes.json'), { schemaVersion: 1, version: '1', entries: [
    { id: 'later', kind: 'plot_fact', text: 'FUTURE_SECRET', fromChapter: 2, toChapter: null, character: null, match: [] },
  ] });
  const first = await f.run(), original = read(first.translation);
  assert.equal(first.remainingIssues, 1);
  await f.run(['accept', f.root, '--number', '1', '--version', first.version]);
  const acceptedPath = join(f.root, 'chapters', '0001', 'accepted.json'), before = read(acceptedPath);
  const feedback = join(f.dir, 'feedback.md'); writeFileSync(feedback, 'Уточнить интонацию.');
  const revision = await f.run(['revise', f.root, '--number', '1', '--notes', feedback]);
  assert.notEqual(revision.version, first.version); assert.notEqual(read(revision.translation), original);
  assert.equal(read(acceptedPath), before); assert.equal(read(first.translation), original);
  await f.run(['accept', f.root, '--number', '1', '--version', revision.version]);
  writeFileSync(join(f.root, 'sources', '0001.txt'), '桌上有四本书。');
  const changed = await f.run();
  assert.notEqual(changed.sourceHash, first.sourceHash); assert.notEqual(changed.version, first.version);
  assert.equal(read(first.translation), original);
  assert.match(await f.run(['accept', f.root, '--number', '1', '--version', revision.version], 1), /stale_version/);
});

test('failure resumes after the saved draft; a completed rerun makes no backend call', async t => {
  const f = setup(t, { mode: 'fail_once', stage: 'review' });
  assert.match(await f.run(f.args, 1), /provider_failed/);
  const result = await f.run();
  assert.equal(result.version, 'v0001'); assert.equal(f.calls().filter(c => c.stage === 'draft').length, 1);
  const count = f.calls().length;
  assert.equal((await f.run()).version, result.version); assert.equal(f.calls().length, count);
});

test('truncated backend JSON and missing source coverage cannot complete a stage or leak stderr', async t => {
  for (const mode of ['invalid_envelope', 'missing_segment']) {
    const f = setup(t, { mode });
    const error = await f.run(f.args, 1);
    assert.match(error, /invalid_backend_response|invalid_model_output/); assert.ok(!error.includes('PRIVATE_PROVIDER_SECRET'));
    const report = await f.run(['status', f.root]);
    assert.equal(report.chapters[0].versions[0].completedStages, 0);
    write(f.control, {}); assert.equal((await f.run()).version, 'v0001');
  }
});

test('budget exhaustion stops immediately despite retries, keeps progress, and leaves unknown usage unknown', async t => {
  const f = setup(t, { mode: 'budget', stage: 'review', omitUsage: true });
  f.book.settings.retries = 2; write(join(f.root, 'book.json'), f.book);
  assert.match(await f.run(f.args, 3), /budget_exceeded/); assert.equal(f.calls().length, 2);
  write(f.control, { omitUsage: true }); const result = await f.run();
  assert.equal(result.version, 'v0001'); assert.equal(f.calls().filter(c => c.stage === 'draft').length, 1);
  assert.equal(result.usage.inputTokens.knownTotal, null); assert.equal(result.usage.inputTokens.unknownCalls, f.calls().length);
});

test('conflicting writer is refused; killing the writer releases its lock and allows resume', async t => {
  const f = setup(t, { mode: 'wait', stage: 'review' }), first = start(f.args);
  let waitingPid: number | undefined;
  t.after(() => { first.process.kill('SIGKILL'); if (waitingPid) { try { process.kill(waitingPid, 'SIGKILL'); } catch { /* exited */ } } });
  for (let i = 0; i < 300 && f.calls().length < 2; i++) await sleep(20);
  assert.equal(f.calls().length, 2); waitingPid = f.calls()[1].pid;
  assert.match(await f.run(f.args, 4), /project_locked/);
  first.process.kill('SIGKILL'); await first.done;
  process.kill(waitingPid, 'SIGKILL'); waitingPid = undefined;
  write(f.control, {}); const result = await f.run();
  assert.equal(result.version, 'v0001'); assert.equal(f.calls().filter(c => c.stage === 'draft').length, 1);
});

test('a real context limit triggers paragraph splitting, and the configured part cap stops further calls', async t => {
  const f = setup(t, { mode: 'limit' });
  const result = await f.run();
  assert.equal(result.parts, 2); assert.equal(result.state, 'complete'); assert.ok(read(result.translation).trim());
  f.book.settings.maxParts = 1; write(join(f.root, 'book.json'), f.book); write(f.control, { mode: 'always_limit' });
  const before = f.calls().length;
  assert.match(await f.run(f.args, 1), /output_limit/); assert.equal(f.calls().length, before + 1);
});
