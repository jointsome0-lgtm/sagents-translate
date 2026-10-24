import { ensure, filled, object } from './core.ts';

export const STAGES = ['draft', 'review', 'edit', 'verify'] as const;
export type Stage = typeof STAGES[number];
export type Unit = { id: string; text: string };
export type Proposal = { source: string; target: string; rationale: string };
export const NOTE_KINDS = ['source_issue', 'question', 'interpretation', 'plot_fact', 'character_belief', 'character_knowledge'] as const;
export type Note = { kind: typeof NOTE_KINDS[number]; text: string; character: string | null; evidence: string };
export const CATEGORIES = ['omission', 'addition', 'negation', 'number', 'actor', 'terminology', 'causality', 'style', 'source_issue'] as const;
export type Issue = { unitId: string; category: typeof CATEGORIES[number]; severity: 'error' | 'warning' | 'question';
  sourceQuote: string; translationQuote: string; description: string; suggestion: string };
type Extras = { glossaryProposals: Proposal[]; notes: Note[] };
export type Translation = Extras & { segments: Unit[] };
export type Review = Extras & { checkedUnitIds: string[]; issues: Issue[] };
export type Output = Translation | Review;

const str = { type: 'string' };
const arr = (items: object) => ({ type: 'array', items });
const shape = (properties: Record<string, object>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const extras = {
  glossaryProposals: arr(shape({ source: str, target: str, rationale: str })),
  notes: arr(shape({ kind: { type: 'string', enum: [...NOTE_KINDS] }, text: str,
    character: { type: ['string', 'null'] }, evidence: str })),
};

export function schemaFor(stage: Stage): object {
  return stage === 'draft' || stage === 'edit' ? shape({ segments: arr(shape({ id: str, text: str })), ...extras })
    : shape({ checkedUnitIds: arr(str), issues: arr(shape({ unitId: str, category: { type: 'string', enum: [...CATEGORIES] },
      severity: { type: 'string', enum: ['error', 'warning', 'question'] }, sourceQuote: str, translationQuote: str,
      description: str, suggestion: str })), ...extras });
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  ensure(Object.keys(value).length === expected.length && expected.every(k => k in value), 'Unexpected model response fields.', 'invalid_model_output');
}

export function validateOutput(value: unknown, stage: Stage, units: Unit[]): Output {
  const check = (ok: unknown) => ensure(ok, 'Model response does not satisfy the stage schema or source coverage.', 'invalid_model_output');
  check(object(value));
  const v = value as Record<string, unknown>;
  const translation = stage === 'draft' || stage === 'edit';
  keys(v, [...(translation ? ['segments'] : ['checkedUnitIds', 'issues']), 'glossaryProposals', 'notes']);
  check(Array.isArray(v.glossaryProposals) && Array.isArray(v.notes));
  for (const proposal of v.glossaryProposals as unknown[]) {
    check(object(proposal)); const p = proposal as Record<string, unknown>;
    keys(p, ['source', 'target', 'rationale']); check(filled(p.source) && filled(p.target) && filled(p.rationale));
  }
  for (const note of v.notes as unknown[]) {
    check(object(note)); const n = note as Record<string, unknown>;
    keys(n, ['kind', 'text', 'character', 'evidence']);
    check(NOTE_KINDS.includes(n.kind as Note['kind']) && filled(n.text) && (n.character === null || filled(n.character)) && typeof n.evidence === 'string');
  }
  if (translation) {
    check(Array.isArray(v.segments) && v.segments.length === units.length);
    (v.segments as unknown[]).forEach((segment, i) => {
      check(object(segment)); const s = segment as Record<string, unknown>;
      keys(s, ['id', 'text']); check(s.id === units[i].id && filled(s.text));
    });
  } else {
    check(Array.isArray(v.checkedUnitIds) && v.checkedUnitIds.length === units.length
      && v.checkedUnitIds.every((id, i) => id === units[i].id) && Array.isArray(v.issues));
    for (const issue of v.issues as unknown[]) {
      check(object(issue)); const i = issue as Record<string, unknown>;
      keys(i, ['unitId', 'category', 'severity', 'sourceQuote', 'translationQuote', 'description', 'suggestion']);
      check(units.some(u => u.id === i.unitId) && CATEGORIES.includes(i.category as Issue['category'])
        && ['error', 'warning', 'question'].includes(i.severity as string) && filled(i.description)
        && ['sourceQuote', 'translationQuote', 'suggestion'].every(k => typeof i[k] === 'string'));
    }
  }
  return v as unknown as Output;
}

export function sourceUnits(text: string): Unit[] {
  return text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/).map(s => s.trim()).filter(Boolean)
    .map((text, i) => ({ id: `p${i + 1}`, text }));
}

// Only after a real request/context/output limit; prefer existing paragraph boundaries.
export function splitUnits(units: Unit[]): [Unit[], Unit[]] | null {
  if (units.length > 1) {
    const half = units.reduce((n, u) => n + u.text.length, 0) / 2;
    let total = 0, index = 1, distance = Infinity;
    for (let i = 1; i < units.length; i++) {
      total += units[i - 1].text.length;
      if (Math.abs(total - half) < distance) { index = i; distance = Math.abs(total - half); }
    }
    return [units.slice(0, index), units.slice(index)];
  }
  const unit = units[0];
  const boundaries = [...unit.text.matchAll(/[。！？；.!?;][”"'’」』）)]*\s*|\n+/gu)]
    .map(m => m.index + m[0].length).filter(n => unit.text.slice(0, n).trim() && unit.text.slice(n).trim());
  if (!boundaries.length) return null;
  const cut = boundaries.sort((a, b) => Math.abs(a - unit.text.length / 2) - Math.abs(b - unit.text.length / 2))[0];
  return [[{ id: `${unit.id}.1`, text: unit.text.slice(0, cut).trim() }],
    [{ id: `${unit.id}.2`, text: unit.text.slice(cut).trim() }]];
}
