// Offline protocol fixture. It never imports sagents and never opens a network connection.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const controlPath = process.argv[2];
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const data = JSON.parse(request.messages[0].content);
appendFileSync(`${controlPath}.calls`, `${JSON.stringify({ stage: data.stage, part: data.part, pid: process.pid,
  units: data.sourceUnits.length, schema: !!request.schema, apiMaxTokens: process.env.SAGENTS_API_MAX_TOKENS ?? null,
  model: request.model })}\n`);
const send = (value: unknown, code = 0) => { console.log(JSON.stringify(value)); process.exitCode = code; };
const fail = (reason: string) => send({ status: 'failed', reason }, 1);

if (process.argv[3] !== 'ask' || process.argv[4] !== '--timeout') fail('invalid_request');
else if (control.forbid?.some((s: string) => JSON.stringify(request).includes(s))) fail('invalid_request');
else if (control.mode === 'fail_once' && control.stage === data.stage) {
  writeFileSync(controlPath, JSON.stringify({ ...control, mode: 'success' }));
  fail(control.reason ?? 'provider_failed');
} else if (control.mode === 'budget' && control.stage === data.stage) fail('budget_exceeded');
else if (control.mode === 'limit' && data.sourceUnits.length > (control.maxUnits ?? 1)) fail(control.reason ?? 'context_limit');
else if (control.mode === 'always_limit') fail(control.reason ?? 'output_limit');
else if (control.mode === 'invalid_envelope') { process.stderr.write('PRIVATE_PROVIDER_SECRET\n'); process.stdout.write('{"status":"done","text":'); }
else {
  if (control.mode === 'wait' && control.stage === data.stage) await sleep(control.waitMs ?? 30_000);
  const translation = data.stage === 'draft' || data.stage === 'edit';
  const dictionary: Record<string, string> = {
    '小林打开门。桌上有三本书。': 'Сяолинь открыла дверь. На столе лежали три книги.',
    '“我没有拿走那封信。”她说。': '«Я не брала то письмо», — сказала она.',
  };
  const segments = data.sourceUnits.map((unit: { id: string; text: string }) => ({ id: unit.id,
    text: `${data.userFeedback ? 'Редакция: ' : ''}${dictionary[unit.text] ?? `Перевод: ${unit.text}`}` }));
  if (control.mode === 'missing_segment') segments.pop();
  const extras = { glossaryProposals: data.sourceUnits.some((u: { text: string }) => u.text.includes('小林'))
    ? [{ source: '小林', target: 'Сяолинь', rationale: 'Synthetic fixture proposal.' }] : [], notes: [] };
  const checkedUnitIds = data.sourceUnits.map((u: { id: string }) => u.id);
  if (control.mode === 'missing_segment') checkedUnitIds.pop();
  const removals = data.sourceUnits.filter((u: { text: string }) => control.remove && u.text.includes(control.remove))
    .map((u: { id: string }) => ({ unitId: u.id, quote: control.remove, occurrence: 1, reason: 'Synthetic site advertisement.' }));
  if (control.mode === 'invalid_cleanup') removals.push({ unitId: checkedUnitIds[0], quote: 'NOT IN SOURCE', occurrence: 1, reason: 'Invalid fixture removal.' });
  const uncertain = data.sourceUnits.filter((u: { text: string }) => control.uncertain && u.text.includes(control.uncertain))
    .map((u: { id: string }) => ({ unitId: u.id, quote: control.uncertain, reason: 'Synthetic ambiguity; keep this text.' }));
  const output = data.stage === 'clean' ? { checkedUnitIds, removals, uncertain }
    : data.stage === 'extract' ? { checkedUnitIds, ...extras } : translation ? { segments, ...extras } : { checkedUnitIds,
    issues: control.remainingIssue ? [{ unitId: data.sourceUnits[0].id, category: 'source_issue', severity: 'question',
      sourceQuote: '', translationQuote: '', description: 'Synthetic unresolved ambiguity.', suggestion: '' }] : [], ...extras };
  const usage = control.omitUsage ? {} : { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: null } };
  send({ status: 'done', text: JSON.stringify(output), ...usage });
}
