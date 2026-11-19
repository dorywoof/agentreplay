import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, detectLoops, detectCacheMisses, formatReport } from '../src/insights.js';
import { DEFAULT_PRICING } from '../src/pricing.js';

const T0 = Date.parse('2026-03-02T10:00:00Z');
const MIN = 60_000;
const M = 'claude-opus-5-5';

function req(t, { ctx = 50_000, read = ctx - 1_000, write = 1_000, output = 500, model = M, id } = {}) {
  return { id: id ?? null, t, model, ctx, input: ctx - read - write, cacheRead: read, cacheWrite: write, cacheWrite1h: 0, output };
}
const tool = (t, summary, isError = false, extra = {}) => ({ kind: 'tool', t, name: 'Bash', summary, isError, output: '', ...extra });
const session = (events, requestLog, extra = {}) => ({
  agent: 'Claude Code',
  cwd: '/work/shop',
  events,
  requestLog,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
  ...extra,
});
const run = (sessions) => analyze({ sessions: sessions.map((s) => ({ session: s, file: 'x.jsonl', agent: 'claude' })), since: T0 - 60 * MIN, now: T0 + 600 * MIN, days: 1 }, DEFAULT_PRICING);

test('a command failing again and again is a retry loop; ordinary reruns are not', () => {
  const loops = detectLoops([
    tool(T0, 'npm test', true),
    tool(T0 + MIN, 'edit', false, { diff: [{}] }),
    tool(T0 + 2 * MIN, 'npm  test', true),
    tool(T0 + 3 * MIN, 'npm test', true),
    tool(T0 + 4 * MIN, 'npm test', false),
    tool(T0 + 5 * MIN, 'git status'),
    tool(T0 + 6 * MIN, 'git status'),
    tool(T0 + 7 * MIN, 'git status'),
  ]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].failures, 3);
  assert.equal(loops[0].attempts, 4);
  assert.equal(loops[0].resolved, true);
});

test('cache misses are classified: pause, model switch; compaction is not a miss', () => {
  const cold = { read: 0, write: 79_000, ctx: 80_000 };
  const misses = detectCacheMisses(
    [
      req(T0, { ctx: 80_000 }),
      req(T0 + 10 * MIN, cold), // pause
      req(T0 + 11 * MIN, { ctx: 81_000 }),
      req(T0 + 12 * MIN, { ...cold, ctx: 82_000, model: 'claude-sonnet-5-5' }), // switch
      req(T0 + 13 * MIN, { ctx: 20_000, read: 0, write: 19_000 }), // compacted: smaller context
    ],
    DEFAULT_PRICING,
  );
  assert.deepEqual(
    misses.map((m) => m.reason),
    ['pause', 'model switch'],
  );
  assert.ok(misses[0].extra > 0);
});

test('a huge tool output is charged for every later request until the context resets', () => {
  const big = 'x'.repeat(40_000); // ≈ 10k tokens
  const s = session(
    [{ kind: 'user', t: T0, text: 'go' }, tool(T0 + MIN, 'cat big.log', false, { output: big.slice(0, 10), outputSize: big.length })],
    [req(T0), req(T0 + 2 * MIN, { ctx: 60_000 }), req(T0 + 3 * MIN, { ctx: 61_000 }), req(T0 + 4 * MIN, { ctx: 20_000, read: 0, write: 19_000 }), req(T0 + 5 * MIN, { ctx: 21_000 })],
  );
  const R = run([s]);
  assert.equal(R.bloat.length, 1);
  assert.equal(R.bloat[0].outputTokens, 10_000);
  assert.equal(R.bloat[0].carriedRequests, 2);
  assert.ok(R.bloat[0].carriedCost > 0);
});

test('requests copied into a resumed session are counted once', () => {
  const original = session([{ kind: 'user', t: T0, text: 'a' }], [req(T0, { id: 'm1' }), req(T0 + MIN, { id: 'm2' })]);
  const resumed = session([{ kind: 'user', t: T0 + 2 * MIN, text: 'b' }], [req(T0, { id: 'm1' }), req(T0 + MIN, { id: 'm2' }), req(T0 + 3 * MIN, { id: 'm3' })]);
  const R = run([resumed, original]);
  assert.equal(R.total.requests, 3);
  assert.equal(R.sessions, 2);
});

test('report renders and unknown models are reported as tokens, not dollars', () => {
  const s = session([{ kind: 'user', t: T0, text: 'a' }], [req(T0, { model: 'mystery-1' }), req(T0 + MIN)], { agent: 'Codex' });
  const R = run([s]);
  assert.deepEqual(R.unpricedModels, ['mystery-1']);
  assert.ok(R.total.unpricedTokens > 0 && R.total.cost > 0);
  const text = formatReport(R);
  assert.match(text, /agentreplayer insights/);
  assert.match(text, /no price for mystery-1/);
});

test('input is split by tokens and by dollars, which tell different stories', () => {
  const s = session([{ kind: 'user', t: T0, text: 'go' }], [req(T0, { ctx: 100_000, read: 96_000, write: 4_000 })]);
  const R = run([s]);
  assert.equal(R.total.cacheRead, 96_000);
  assert.equal(R.total.cacheWrite, 4_000);
  const c = R.total.inputCost;
  assert.ok(Math.abs(c.cacheRead - 0.0192) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite - 0.02) < 1e-9);
  assert.equal(c.input, 0);
  const out = formatReport(R);
  assert.match(out, /input tokens: 96% cache reads · 4% cache writes · 0% uncached/);
  assert.match(out, /input cost: +49% cache reads · 51% cache writes · 0% uncached/);
});

test('the long-prompt share is given in tokens and in dollars', () => {
  const s = session([{ kind: 'user', t: T0, text: 'go' }], [req(T0, { ctx: 20_000, read: 0, write: 20_000 }), req(T0 + MIN, { ctx: 180_000, read: 180_000, write: 0 })]);
  const out = formatReport(run([s]));
  assert.match(out, /90% of input tokens \(26% of input cost\) were sent in prompts over 100k/);
});
