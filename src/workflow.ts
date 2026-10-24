import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSagentsBackend, requestHash, usageSummary } from './backend.ts';
import type { Backend, BackendConfig, ModelOptions, Request, Usage } from './backend.ts';
import { materialFor, readBook, validModel, WORKFLOW } from './book.ts';
import type { Material } from './book.ts';
import { AppError, chapterName, digest, ensure, hash, integer, now, object, parseJSON } from './core.ts';
import { schemaFor, sourceUnits, splitUnits, STAGES, validateOutput } from './outputs.ts';
import type { Issue, Output, Review, Stage, Translation, Unit } from './outputs.ts';
import { atomicWrite, readJSON, readText, withBookLock, writeJSON } from './storage.ts';

type Attempt = { stage: Stage; startedAt: string; finishedAt?: string; requestHash: string;
  outcome: 'pending' | 'done' | 'failed' | 'interrupted'; reason?: string; usage?: Usage; endpoint?: string };
type Checkpoint = { completedAt: string; output: Output; outputHash: string };
type Part = { id: string; units: Unit[]; stages: Partial<Record<Stage, Checkpoint>>; attempts: Attempt[];
  children?: [string, string]; splitReason?: string };
type Inputs = { workflow: string; chapter: number; kind: 'chapter' | 'revise'; material: Material;
  model: ModelOptions; backend: Record<string, unknown>; retries: number; maxParts: number;
  feedback: { text: string; hash: string } | null; base: { version: string; textHash: string; segments: Unit[] } | null };
export type Run = { schemaVersion: 1; version: string; fingerprint: string; createdAt: string;
  completedAt?: string; inputs: Inputs; parts: Part[]; state: 'running' | 'stopped' | 'complete'; stopReason?: string };
type Accepted = { schemaVersion: 1; version: string; textHash: string; acceptedAt: string;
  history: { version: string; textHash: string; acceptedAt: string }[] };
export type RunOptions = { number: number; model?: string; timeoutSeconds?: number; apiMaxTokens?: number;
  notes?: string; base?: string; signal?: AbortSignal; progress?: (event: Record<string, unknown>) => void };
type BackendFactory = (config: BackendConfig, options: ModelOptions) => Backend;

const versionPattern = /^v\d{4,}$/;
const directory = (root: string, number: number) => join(root, 'chapters', chapterName(number));
export const runDirectory = (root: string, number: number, version: string): string => join(directory(root, number), 'versions', version);
const save = (root: string, run: Run) => writeJSON(join(runDirectory(root, run.inputs.chapter, run.version), 'run.json'),
  { schemaVersion: 1, checksum: digest(run), run });

export function readRun(root: string, number: number, version: string): Run {
  ensure(versionPattern.test(version), 'Invalid version id.', 'invalid_options');
  const value = readJSON(join(runDirectory(root, number, version), 'run.json'));
  ensure(object(value) && value.schemaVersion === 1 && object(value.run) && value.checksum === digest(value.run),
    'Run checkpoint checksum/schema mismatch. Restore it from a backup; it will not be overwritten.', 'damaged_checkpoint');
  const run = value.run as unknown as Run;
  ensure(run.schemaVersion === 1 && run.version === version && run.inputs.chapter === number
    && run.inputs.workflow === WORKFLOW && run.fingerprint === digest(run.inputs), 'Unsupported or damaged run checkpoint.', 'damaged_checkpoint');
  return run;
}

function versions(root: string, number: number): string[] {
  const path = join(directory(root, number), 'versions');
  return existsSync(path) ? readdirSync(path).filter(name => versionPattern.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : [];
}
export function readRuns(root: string, number: number): Run[] {
  // A crash before the first checkpoint may leave an empty version directory.
  return versions(root, number).filter(v => existsSync(join(runDirectory(root, number, v), 'run.json'))).map(v => readRun(root, number, v));
}

function acceptedAt(root: string, number: number): Accepted | null {
  const path = join(directory(root, number), 'accepted.json');
  if (!existsSync(path)) return null;
  const v = readJSON(path);
  ensure(object(v) && v.schemaVersion === 1 && typeof v.version === 'string' && versionPattern.test(v.version)
    && typeof v.textHash === 'string' && typeof v.acceptedAt === 'string' && Array.isArray(v.history), 'Invalid acceptance record.', 'damaged_checkpoint');
  const run = readRun(root, number, v.version);
  ensure(run.state === 'complete' && hash(translationText(run)) === v.textHash, 'Accepted version is missing or damaged.', 'damaged_checkpoint');
  return v as unknown as Accepted;
}

export function leaves(run: Run): Part[] {
  const byId = new Map(run.parts.map(part => [part.id, part]));
  const visit = (id: string): Part[] => {
    const part = byId.get(id)!;
    return part.children ? part.children.flatMap(visit) : [part];
  };
  return visit('1');
}
export const segmentsOf = (run: Run): Unit[] => leaves(run).flatMap(p => (p.stages.edit!.output as Translation).segments);
export const translationText = (run: Run): string => `${segmentsOf(run).map(s => s.text).join('\n\n')}\n`;
const remainingIssues = (run: Run): (Issue & { part: string })[] => leaves(run).flatMap(p =>
  (p.stages.verify!.output as Review).issues.map(issue => ({ ...issue, part: p.id })));

function materialize(root: string, run: Run): void {
  const path = runDirectory(root, run.inputs.chapter, run.version);
  atomicWrite(join(path, 'translation.md'), translationText(run));
  writeJSON(join(path, 'remaining-issues.json'), { schemaVersion: 1, version: run.version, issues: remainingIssues(run) });
  const proposals = leaves(run).flatMap(p => STAGES.flatMap(stage => {
    const output = p.stages[stage]!.output;
    return [ { part: p.id, stage, glossaryProposals: output.glossaryProposals, notes: output.notes } ];
  }));
  writeJSON(join(path, 'proposals.json'), { schemaVersion: 1, accepted: false, version: run.version, proposals });
}

function related(base: Unit[], units: Unit[]): Unit[] {
  return base.filter(b => units.some(u => u.id === b.id || u.id.startsWith(`${b.id}.`) || b.id.startsWith(`${u.id}.`)));
}

function requestFor(run: Run, part: Part, stage: Stage, structuredOutput: boolean): Request {
  const { material, model, feedback, base } = run.inputs;
  const candidate = stage === 'review' || stage === 'edit' ? part.stages.draft?.output : stage === 'verify' ? part.stages.edit?.output : undefined;
  const data = {
    stage, chapter: run.inputs.chapter, part: part.id, sourceLanguage: material.from, targetLanguage: material.to,
    sourceUnits: part.units, context: material.context,
    ...(feedback ? { userFeedback: feedback.text } : {}),
    ...(base ? { baseTranslation: related(base.segments, part.units) } : {}),
    ...(candidate ? { candidate } : {}),
    ...(stage === 'edit' || stage === 'verify' ? { review: part.stages.review!.output } : {}),
  };
  const schema = schemaFor(stage);
  return { model: model.model, system: `${material.prompts.rules}\n\n${material.prompts.stages[stage]}\n\nResponse JSON Schema:\n${JSON.stringify(schema)}`,
    messages: [{ role: 'user', content: JSON.stringify(data) }], ...(structuredOutput ? { schema } : {}) };
}

const RETRYABLE = new Set(['rate_limited', 'model_unavailable', 'provider_failed', 'timeout', 'incomplete_stream',
  'invalid_stream', 'invalid_response', 'empty_response', 'invalid_backend_response', 'invalid_model_output']);
const LIMITS = new Set(['context_limit', 'output_limit', 'request_limit']);

function stopped(root: string, run: Run, reason: string): never {
  run.state = 'stopped'; run.stopReason = reason; save(root, run);
  const advice = LIMITS.has(reason) ? ' Increase the supported API output setting or reduce context; the configured split limit or sentence boundary was reached.'
    : reason === 'budget_exceeded' ? ' No further calls were made. Resume after the backend budget is available.' : ' Correct the cause and rerun the same command to resume.';
  throw new AppError(reason, `Version ${run.version} stopped (${reason}); completed stages are saved.${advice}`);
}

export async function runChapter(root: string, options: RunOptions, factory: BackendFactory = createSagentsBackend): Promise<Run> {
  return withBookLock(root, async () => {
    ensure(integer(options.number, 1), 'Specify a positive --number.', 'invalid_options');
    const { book, material } = materialFor(root, options.number), runs = readRuns(root, options.number);
    const kind = options.notes === undefined ? 'chapter' : 'revise';
    let baseRun: Run | undefined;
    if (kind === 'revise') {
      const accepted = acceptedAt(root, options.number);
      baseRun = options.base ? readRun(root, options.number, options.base) : accepted ? readRun(root, options.number, accepted.version)
        : runs.filter(r => r.state === 'complete' && r.inputs.kind === 'chapter').at(-1);
      ensure(baseRun?.state === 'complete', 'Revision needs an accepted or completed chapter version (or --base).', 'base_not_found');
      ensure(baseRun.inputs.material.sourceHash === material.sourceHash, 'Source changed since the base version. Run chapter first, then revise that version.', 'base_source_changed');
    }
    const model = options.model ?? baseRun?.inputs.model.model ?? book.settings.model;
    ensure(validModel(model), 'Specify --model or settings.model in book.json.', 'invalid_options');
    const settings: ModelOptions = { model, timeoutSeconds: options.timeoutSeconds ?? book.settings.timeoutSeconds,
      apiMaxTokens: options.apiMaxTokens ?? book.settings.apiMaxTokens };
    ensure(integer(settings.timeoutSeconds, 1, 3600) && (settings.apiMaxTokens === null || integer(settings.apiMaxTokens, 1)), 'Invalid model settings.', 'invalid_options');
    const backend = factory(book.backend, settings);
    const feedbackText = options.notes === undefined ? null : readText(options.notes);
    ensure(feedbackText === null || feedbackText.trim().length, 'Feedback file is empty.', 'invalid_options');
    const inputs: Inputs = { workflow: WORKFLOW, chapter: options.number, kind, material, model: settings, backend: backend.identity,
      retries: book.settings.retries, maxParts: book.settings.maxParts,
      feedback: feedbackText === null ? null : { text: feedbackText, hash: hash(feedbackText) },
      base: baseRun ? { version: baseRun.version, textHash: hash(translationText(baseRun)), segments: segmentsOf(baseRun) } : null };
    const fingerprint = digest(inputs);
    let run = runs.findLast(r => r.fingerprint === fingerprint);
    if (!run) {
      const ids = versions(root, options.number);
      const version = `v${String(ids.length ? Number(ids.at(-1)!.slice(1)) + 1 : 1).padStart(4, '0')}`;
      run = { schemaVersion: 1, version, fingerprint, createdAt: now(), inputs, state: 'running',
        parts: [{ id: '1', units: baseRun ? leaves(baseRun).flatMap(p => p.units) : sourceUnits(material.source), stages: {}, attempts: [] }] };
      mkdirSync(runDirectory(root, options.number, version), { recursive: true, mode: 0o700 });
      save(root, run); // Preparation is durable before the first model call.
    }
    const current = run;
    if (current.state === 'complete') { materialize(root, current); return current; }
    for (const part of current.parts) for (const attempt of part.attempts) {
      if (attempt.outcome === 'pending') { attempt.outcome = 'interrupted'; attempt.reason = 'process_interrupted'; attempt.finishedAt = now(); }
    }
    current.state = 'running'; delete current.stopReason; save(root, current);
    const materialDigest = digest(material), bookDigest = digest(book);
    const unchanged = () => {
      const fresh = materialFor(root, options.number);
      if (digest(fresh.material) !== materialDigest || digest(fresh.book) !== bookDigest
        || (options.notes !== undefined && hash(readText(options.notes)) !== inputs.feedback!.hash)) stopped(root, current, 'inputs_changed');
    };
    for (;;) {
      const part = leaves(current).find(p => !p.stages.verify);
      if (!part) break;
      let split = false;
      for (const stage of STAGES) {
        if (part.stages[stage]) continue;
        for (let retry = 0; ; retry++) {
          if (options.signal?.aborted) stopped(root, current, 'cancelled');
          unchanged();
          const request = requestFor(current, part, stage, book.backend.structuredOutput);
          const attempt: Attempt = { stage, startedAt: now(), requestHash: requestHash(request), outcome: 'pending' };
          part.attempts.push(attempt); save(root, current);
          options.progress?.({ version: current.version, part: part.id, stage, state: 'started' });
          let reason: string | undefined;
          try {
            const reply = await backend.respond(request, options.signal);
            if (reply.usage !== undefined) attempt.usage = reply.usage;
            if (reply.status === 'failed') reason = reply.reason;
            else {
              if (reply.endpoint) attempt.endpoint = reply.endpoint;
              const output = validateOutput(parseJSON(reply.text, 'Invalid model JSON.', 'invalid_model_output'), stage, part.units);
              part.stages[stage] = { completedAt: now(), output, outputHash: digest(output) };
            }
          } catch (error) { reason = error instanceof AppError ? error.code : 'backend_error'; }
          attempt.finishedAt = now(); attempt.outcome = reason ? 'failed' : 'done';
          if (reason) attempt.reason = reason;
          save(root, current);
          options.progress?.({ version: current.version, part: part.id, stage, state: reason ? 'failed' : 'done', ...(reason ? { reason } : {}) });
          if (!reason) break;
          if (options.signal?.aborted) stopped(root, current, 'cancelled');
          if (LIMITS.has(reason)) {
            const halves = leaves(current).length < current.inputs.maxParts ? splitUnits(part.units) : null;
            if (!halves) stopped(root, current, reason);
            part.children = [`${part.id}.1`, `${part.id}.2`]; part.splitReason = reason;
            current.parts.push(...halves.map((units, i) => ({ id: part.children![i], units, stages: {}, attempts: [] })));
            save(root, current); split = true;
            options.progress?.({ version: current.version, part: part.id, state: 'split', reason });
            break;
          }
          if (retry < current.inputs.retries && RETRYABLE.has(reason)) continue;
          stopped(root, current, reason);
        }
        if (split) break;
      }
    }
    unchanged();
    current.state = 'complete'; current.completedAt = now(); delete current.stopReason; save(root, current);
    materialize(root, current);
    return current;
  });
}

export async function acceptVersion(root: string, number: number, version: string): Promise<Accepted> {
  return withBookLock(root, () => {
    const run = readRun(root, number, version);
    ensure(run.state === 'complete', 'Only a completed version can be accepted.', 'incomplete_version');
    const { material } = materialFor(root, number);
    ensure(digest(material) === digest(run.inputs.material), 'Source, context, languages or prompts changed. Produce and review a current version before accepting.', 'stale_version');
    const previous = acceptedAt(root, number);
    if (previous?.version === version) return previous;
    materialize(root, run);
    const accepted: Accepted = { schemaVersion: 1, version, textHash: hash(translationText(run)), acceptedAt: now(),
      history: previous ? [...previous.history, { version: previous.version, textHash: previous.textHash, acceptedAt: previous.acceptedAt }] : [] };
    writeJSON(join(directory(root, number), 'accepted.json'), accepted);
    return accepted;
  });
}

export function runSummary(root: string, run: Run) {
  return { version: run.version, state: run.state, kind: run.inputs.kind, fingerprint: run.fingerprint,
    sourceHash: run.inputs.material.sourceHash, parts: leaves(run).length,
    completedStages: leaves(run).reduce((n, p) => n + Object.keys(p.stages).length, 0),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.state === 'complete' ? { translation: join(runDirectory(root, run.inputs.chapter, run.version), 'translation.md'), remainingIssues: remainingIssues(run).length } : {}),
    usage: usageSummary(run.parts.flatMap(p => p.attempts)) };
}

export function status(root: string) {
  const book = readBook(root);
  return { schemaVersion: 1, from: book.from, to: book.to, chapters: book.chapters.map(chapter => {
    const { material } = materialFor(root, chapter.number);
    const runs = readRuns(root, chapter.number), accepted = acceptedAt(root, chapter.number);
    return { number: chapter.number, accepted: accepted ? { version: accepted.version, textHash: accepted.textHash,
      translation: join(runDirectory(root, chapter.number, accepted.version), 'translation.md'),
      stale: digest(readRun(root, chapter.number, accepted.version).inputs.material) !== digest(material) } : null,
      versions: runs.map(run => ({ ...runSummary(root, run), stale: digest(run.inputs.material) !== digest(material) })) };
  }) };
}
