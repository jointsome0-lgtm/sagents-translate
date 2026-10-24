import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSagentsBackend, requestHash, usageSummary } from './backend.ts';
import type { Backend, BackendConfig, ModelOptions, Request, Usage } from './backend.ts';
import { materialFor, readBook, validModel, WORKFLOW } from './book.ts';
import type { Material } from './book.ts';
import { AppError, chapterName, digest, ensure, hash, integer, now, object, parseJSON } from './core.ts';
import { applyCleaning, schemaFor, sourceUnits, splitUnits, STAGES, validateOutput } from './outputs.ts';
import type { Cleaning, Extraction, Issue, Output, Review, Stage, Translation, Unit } from './outputs.ts';
import { atomicWrite, readJSON, readText, withBookLock, writeJSON } from './storage.ts';

type Attempt = { stage: Stage; startedAt: string; finishedAt?: string; requestHash: string;
  outcome: 'pending' | 'done' | 'failed' | 'interrupted'; reason?: string; usage?: Usage; endpoint?: string };
type Checkpoint = { completedAt: string; output: Output; outputHash: string };
type Part = { id: string; units: Unit[]; stages: Partial<Record<Stage, Checkpoint>>; attempts: Attempt[];
  children?: [string, string]; splitReason?: string };
type Inputs = { workflow: string; chapter: number; kind: 'chapter' | 'revise'; material: Material;
  model: ModelOptions; backend: Record<string, unknown>; retries: number; maxParts: number;
  preparation?: Record<'clean' | 'extract', { model: ModelOptions; backend: Record<string, unknown> }>;
  feedback: { text: string; hash: string } | null; base: { version: string; textHash: string; segments: Unit[] } | null };
export type Run = { schemaVersion: 1; version: string; fingerprint: string; createdAt: string;
  completedAt?: string; inputs: Inputs; parts: Part[]; state: 'running' | 'prepared' | 'stopped' | 'complete'; stopReason?: string;
  preparation?: { clean: Part[]; extract: Part[]; cleanedSourceHash?: string; reused?: Partial<Record<'clean' | 'extract', string>> } };
type Accepted = { schemaVersion: 1; version: string; textHash: string; acceptedAt: string;
  history: { version: string; textHash: string; acceptedAt: string }[] };
export type RunOptions = { number: number; model?: string; timeoutSeconds?: number; apiMaxTokens?: number;
  cleanModel?: string; extractModel?: string; prepareOnly?: boolean;
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
    && ['chapter/1', WORKFLOW].includes(run.inputs.workflow) && run.fingerprint === digest(run.inputs), 'Unsupported or damaged run checkpoint.', 'damaged_checkpoint');
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

function partLeaves(parts: Part[]): Part[] {
  if (!parts.length) return [];
  const byId = new Map(parts.map(part => [part.id, part]));
  const visit = (id: string): Part[] => {
    const part = byId.get(id)!;
    return part.children ? part.children.flatMap(visit) : [part];
  };
  return visit('1');
}
export const leaves = (run: Run): Part[] => partLeaves(run.parts);
const allParts = (run: Run): Part[] => [...(run.preparation?.clean ?? []), ...(run.preparation?.extract ?? []), ...run.parts];
const initialParts = (units: Unit[]): Part[] => [{ id: '1', units, stages: {}, attempts: [] }];
const sourceText = (units: Unit[]): string => `${units.map(u => u.text).join('\n\n')}\n`;
const cleanedUnits = (run: Run): Unit[] => partLeaves(run.preparation!.clean)
  .flatMap(p => applyCleaning(p.units, p.stages.clean!.output as Cleaning));
const phaseComplete = (parts: Part[], stage: Stage): boolean => parts.length > 0 && partLeaves(parts).every(p => p.stages[stage]);
export const segmentsOf = (run: Run): Unit[] => leaves(run).flatMap(p => (p.stages.edit!.output as Translation).segments);
export const translationText = (run: Run): string => `${segmentsOf(run).map(s => s.text).join('\n\n')}\n`;
const remainingIssues = (run: Run): (Issue & { part: string })[] => leaves(run).flatMap(p =>
  (p.stages.verify!.output as Review).issues.map(issue => ({ ...issue, part: p.id })));

function materialize(root: string, run: Run): void {
  const path = runDirectory(root, run.inputs.chapter, run.version);
  atomicWrite(join(path, 'translation.md'), translationText(run));
  writeJSON(join(path, 'remaining-issues.json'), { schemaVersion: 1, version: run.version, issues: remainingIssues(run) });
  const proposals = [...partLeaves(run.preparation?.extract ?? []), ...leaves(run)].flatMap(p => (['extract', ...STAGES] as Stage[]).flatMap(stage => {
    if (!p.stages[stage]) return [];
    const output = p.stages[stage]!.output;
    return 'glossaryProposals' in output ? [ { part: p.id, stage, glossaryProposals: output.glossaryProposals, notes: output.notes } ] : [];
  }));
  writeJSON(join(path, 'proposals.json'), { schemaVersion: 1, accepted: false, version: run.version, proposals });
  materializePreparation(root, run);
}

function materializePreparation(root: string, run: Run): void {
  if (!run.preparation || !phaseComplete(run.preparation.clean, 'clean')) return;
  const path = runDirectory(root, run.inputs.chapter, run.version), units = cleanedUnits(run);
  atomicWrite(join(path, 'cleaned.txt'), sourceText(units));
  writeJSON(join(path, 'cleanup.json'), { schemaVersion: 1, sourceHash: run.inputs.material.sourceHash,
    cleanedSourceHash: hash(sourceText(units)), parts: partLeaves(run.preparation.clean).map(p => ({ part: p.id, ...p.stages.clean!.output })) });
  writeJSON(join(path, 'extraction.json'), { schemaVersion: 1, accepted: false,
    complete: phaseComplete(run.preparation.extract, 'extract'),
    parts: partLeaves(run.preparation.extract).filter(p => p.stages.extract).map(p => ({ part: p.id, ...p.stages.extract!.output })) });
}

function related(base: Unit[], units: Unit[]): Unit[] {
  return base.filter(b => units.some(u => u.id === b.id || u.id.startsWith(`${b.id}.`) || b.id.startsWith(`${u.id}.`)));
}

function requestFor(run: Run, part: Part, stage: Stage, structuredOutput: boolean): Request {
  const { material, model, feedback, base } = run.inputs;
  const schema = schemaFor(stage);
  if (stage === 'clean') return { model: run.inputs.preparation!.clean.model.model,
    system: `${material.prompts.stages.clean}\n\nResponse JSON Schema:\n${JSON.stringify(schema)}`,
    messages: [{ role: 'user', content: JSON.stringify({ stage, chapter: run.inputs.chapter, part: part.id,
      sourceLanguage: material.from, sourceUnits: part.units }) }], ...(structuredOutput ? { schema } : {}) };
  const candidate = stage === 'review' || stage === 'edit' ? part.stages.draft?.output : stage === 'verify' ? part.stages.edit?.output : undefined;
  const proposals = partLeaves(run.preparation?.extract ?? []).flatMap(p => p.stages.extract ? [p.stages.extract.output as Extraction] : []);
  const mentioned = (words: string[]) => words.some(w => part.units.some(u => u.text.toLowerCase().includes(w.toLowerCase())));
  const context = { ...material.context,
    glossary: material.context.glossary.filter(e => mentioned([e.source, ...e.aliases])),
    notes: material.context.notes.filter(e => !e.match.length || mentioned(e.match)) };
  const data = {
    stage, chapter: run.inputs.chapter, part: part.id, sourceLanguage: material.from, targetLanguage: material.to,
    sourceUnits: part.units, context,
    ...(stage !== 'extract' ? { proposedContext: { accepted: false,
      glossaryProposals: proposals.flatMap(p => p.glossaryProposals).filter(p => part.units.some(u => u.text.includes(p.source))),
      notes: proposals.flatMap(p => p.notes).filter(n => part.units.some(u => u.text.includes(n.evidence))) } } : {}),
    ...(feedback && stage !== 'extract' ? { userFeedback: feedback.text } : {}),
    ...(base && stage !== 'extract' ? { baseTranslation: related(base.segments, part.units) } : {}),
    ...(candidate ? { candidate } : {}),
    ...(stage === 'edit' || stage === 'verify' ? { review: part.stages.review!.output } : {}),
  };
  return { model: stage === 'extract' ? run.inputs.preparation!.extract.model.model : model.model,
    system: `${material.prompts.rules}\n\n${material.prompts.stages[stage]}\n\nResponse JSON Schema:\n${JSON.stringify(schema)}`,
    messages: [{ role: 'user', content: JSON.stringify(data) }], ...(structuredOutput ? { schema } : {}) };
}

const RETRYABLE = new Set(['rate_limited', 'model_unavailable', 'provider_failed', 'timeout', 'incomplete_stream',
  'invalid_stream', 'invalid_response', 'empty_response', 'invalid_backend_response', 'invalid_model_output']);
const LIMITS = new Set(['context_limit', 'output_limit', 'request_limit']);

function stopped(root: string, run: Run, reason: string): never {
  run.state = 'stopped'; run.stopReason = reason; save(root, run);
  const advice = LIMITS.has(reason) ? ' Increase the supported API output setting or reduce context; the configured split limit or sentence boundary was reached.'
    : reason === 'budget_exceeded' ? ' No further calls were made. Resume after the backend budget is available.'
    : reason === 'base_cleaned_source_changed' ? ' Cleanup changed the source used by the base version. Run chapter first, then revise its new version.'
    : reason === 'empty_cleaned_source' ? ' Cleanup removed the entire chapter. Review its checkpoint and correct the source or cleanup prompt before rerunning.'
    : ' Correct the cause and rerun the same command to resume.';
  throw new AppError(reason, `Version ${run.version} stopped (${reason}); completed stages are saved.${advice}`);
}

function preparationKey(inputs: Inputs, stage: 'clean' | 'extract', cleanedSourceHash?: string): string {
  const m = inputs.material;
  return digest({ workflow: inputs.workflow, chapter: inputs.chapter, sourceHash: m.sourceHash, from: m.from,
    role: inputs.preparation![stage], prompt: m.prompts.stages[stage], promptVersion: m.prompts.version, maxParts: inputs.maxParts,
    ...(stage === 'extract' ? { cleanedSourceHash, to: m.to, contextHash: m.contextHash, rules: m.prompts.rules } : {}) });
}

function prepareParts(run: Run, runs: Run[], stage: 'clean' | 'extract', units: Unit[]): void {
  const preparation = run.preparation!;
  const key = preparationKey(run.inputs, stage, preparation.cleanedSourceHash);
  const previous = runs.findLast(r => r.inputs.preparation && r.preparation && phaseComplete(r.preparation[stage], stage)
    && preparationKey(r.inputs, stage, r.preparation.cleanedSourceHash) === key);
  if (previous) {
    preparation[stage] = structuredClone(previous.preparation![stage]);
    for (const part of preparation[stage]) part.attempts = []; // Prior calls are charged only to their original run.
    (preparation.reused ??= {})[stage] = previous.version;
  } else preparation[stage] = initialParts(units);
}

async function executeParts(root: string, run: Run, parts: Part[], stages: readonly Stage[], backend: Backend,
  options: RunOptions, structuredOutput: boolean, unchanged: () => void): Promise<void> {
  for (;;) {
    const part = partLeaves(parts).find(p => !p.stages[stages.at(-1)!]);
    if (!part) return;
    let split = false;
    for (const stage of stages) {
      if (part.stages[stage]) continue;
      for (let retry = 0; ; retry++) {
        if (options.signal?.aborted) stopped(root, run, 'cancelled');
        unchanged();
        const request = requestFor(run, part, stage, structuredOutput);
        const attempt: Attempt = { stage, startedAt: now(), requestHash: requestHash(request), outcome: 'pending' };
        part.attempts.push(attempt); save(root, run);
        options.progress?.({ version: run.version, part: part.id, stage, state: 'started' });
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
        save(root, run);
        options.progress?.({ version: run.version, part: part.id, stage, state: reason ? 'failed' : 'done', ...(reason ? { reason } : {}) });
        if (!reason) break;
        if (options.signal?.aborted) stopped(root, run, 'cancelled');
        if (LIMITS.has(reason)) {
          const halves = partLeaves(parts).length < run.inputs.maxParts ? splitUnits(part.units) : null;
          if (!halves) stopped(root, run, reason);
          part.children = [`${part.id}.1`, `${part.id}.2`]; part.splitReason = reason;
          parts.push(...halves.map((units, i) => ({ id: part.children![i], units, stages: {}, attempts: [] })));
          save(root, run); split = true;
          options.progress?.({ version: run.version, part: part.id, stage, state: 'split', reason });
          break;
        }
        if (retry < run.inputs.retries && RETRYABLE.has(reason)) continue;
        stopped(root, run, reason);
      }
      if (split) break;
    }
  }
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
    const cleanModel = options.cleanModel ?? book.settings.cleanModel ?? model;
    const extractModel = options.extractModel ?? book.settings.extractModel ?? model;
    ensure(validModel(cleanModel) && validModel(extractModel), 'Invalid preparation model.', 'invalid_options');
    const timeoutSeconds = options.timeoutSeconds ?? book.settings.timeoutSeconds, apiMaxTokens = options.apiMaxTokens ?? book.settings.apiMaxTokens;
    ensure(integer(timeoutSeconds, 1, 3600) && (apiMaxTokens === null || integer(apiMaxTokens, 1)), 'Invalid model settings.', 'invalid_options');
    ensure(apiMaxTokens === null || [model, cleanModel, extractModel].some(m => m.startsWith('api:')),
      '--api-max-tokens applies only to api: models.', 'invalid_options');
    const roleSettings = (model: string): ModelOptions => ({ model, timeoutSeconds, apiMaxTokens: model.startsWith('api:') ? apiMaxTokens : null });
    const settings = roleSettings(model), backend = factory(book.backend, settings);
    const cleanSettings = roleSettings(cleanModel), extractSettings = roleSettings(extractModel);
    const cleanBackend = factory(book.backend, cleanSettings), extractBackend = factory(book.backend, extractSettings);
    const feedbackText = options.notes === undefined ? null : readText(options.notes);
    ensure(feedbackText === null || feedbackText.trim().length, 'Feedback file is empty.', 'invalid_options');
    const inputs: Inputs = { workflow: WORKFLOW, chapter: options.number, kind, material, model: settings, backend: backend.identity,
      preparation: { clean: { model: cleanSettings, backend: cleanBackend.identity }, extract: { model: extractSettings, backend: extractBackend.identity } },
      retries: book.settings.retries, maxParts: book.settings.maxParts,
      feedback: feedbackText === null ? null : { text: feedbackText, hash: hash(feedbackText) },
      base: baseRun ? { version: baseRun.version, textHash: hash(translationText(baseRun)), segments: segmentsOf(baseRun) } : null };
    const fingerprint = digest(inputs);
    let run = runs.findLast(r => r.fingerprint === fingerprint);
    if (!run) {
      const ids = versions(root, options.number);
      const version = `v${String(ids.length ? Number(ids.at(-1)!.slice(1)) + 1 : 1).padStart(4, '0')}`;
      run = { schemaVersion: 1, version, fingerprint, createdAt: now(), inputs, state: 'running',
        parts: [], preparation: { clean: [], extract: [] } };
      prepareParts(run, runs, 'clean', sourceUnits(material.source));
      mkdirSync(runDirectory(root, options.number, version), { recursive: true, mode: 0o700 });
      save(root, run); // Preparation is durable before the first model call.
    }
    const current = run;
    if (current.state === 'complete') { materialize(root, current); return current; }
    for (const part of allParts(current)) for (const attempt of part.attempts) {
      if (attempt.outcome === 'pending') { attempt.outcome = 'interrupted'; attempt.reason = 'process_interrupted'; attempt.finishedAt = now(); }
    }
    current.state = 'running'; delete current.stopReason; save(root, current);
    const materialDigest = digest(material), bookDigest = digest(book);
    const unchanged = () => {
      const fresh = materialFor(root, options.number);
      if (digest(fresh.material) !== materialDigest || digest(fresh.book) !== bookDigest
        || (options.notes !== undefined && hash(readText(options.notes)) !== inputs.feedback!.hash)) stopped(root, current, 'inputs_changed');
    };
    const preparation = current.preparation!;
    await executeParts(root, current, preparation.clean, ['clean'], cleanBackend, options, book.backend.structuredOutput, unchanged);
    const units = cleanedUnits(current);
    if (!units.length) stopped(root, current, 'empty_cleaned_source');
    preparation.cleanedSourceHash = hash(sourceText(units));
    if (!preparation.extract.length) prepareParts(current, runs, 'extract', units);
    save(root, current); materializePreparation(root, current);
    await executeParts(root, current, preparation.extract, ['extract'], extractBackend, options, book.backend.structuredOutput, unchanged);
    materializePreparation(root, current);
    unchanged();
    if (options.prepareOnly) {
      current.state = 'prepared'; save(root, current); return current;
    }
    if (baseRun) {
      const baseSourceHash = baseRun.preparation?.cleanedSourceHash ?? hash(sourceText(sourceUnits(baseRun.inputs.material.source)));
      if (baseSourceHash !== preparation.cleanedSourceHash) stopped(root, current, 'base_cleaned_source_changed');
    }
    if (!current.parts.length) {
      current.parts = initialParts(baseRun ? leaves(baseRun).flatMap(p => p.units) : units);
      save(root, current);
    }
    await executeParts(root, current, current.parts, STAGES, backend, options, book.backend.structuredOutput, unchanged);
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
  const path = runDirectory(root, run.inputs.chapter, run.version);
  return { version: run.version, state: run.state, kind: run.inputs.kind, fingerprint: run.fingerprint,
    sourceHash: run.inputs.material.sourceHash, parts: leaves(run).length,
    completedStages: [...leaves(run), ...partLeaves(run.preparation?.clean ?? []), ...partLeaves(run.preparation?.extract ?? [])]
      .reduce((n, p) => n + Object.keys(p.stages).length, 0),
    ...(run.preparation?.cleanedSourceHash ? { cleanedSourceHash: run.preparation.cleanedSourceHash,
      cleanedSource: join(path, 'cleaned.txt'), cleanup: join(path, 'cleanup.json'), extraction: join(path, 'extraction.json'),
      reusedPreparation: run.preparation.reused ?? {} } : {}),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.state === 'complete' ? { translation: join(runDirectory(root, run.inputs.chapter, run.version), 'translation.md'), remainingIssues: remainingIssues(run).length } : {}),
    usage: usageSummary(allParts(run).flatMap(p => p.attempts)) };
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
