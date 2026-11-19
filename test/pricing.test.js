import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, rateFor, requestCost } from '../src/pricing.js';
import { computeStats } from '../src/stats.js';
import { analyze } from '../src/insights.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('provider prefixes and date suffixes still find the price', () => {
  assert.equal(rateFor('anthropic/claude-sonnet-4-6', DEFAULT_PRICING), DEFAULT_PRICING['claude-sonnet-4-6']);
  assert.equal(rateFor('us.anthropic.claude-opus-4-8-v1:0', DEFAULT_PRICING), DEFAULT_PRICING['claude-opus-4-8']);
  assert.equal(rateFor('claude-opus-5-5-20260901', DEFAULT_PRICING), DEFAULT_PRICING['claude-opus-5-5']);
  assert.equal(rateFor('gpt-5', DEFAULT_PRICING), null);
});

test('Haiku 5.5 prompts over 100k use the higher tier, for the whole request', () => {
  const short = requestCost({ model: 'claude-haiku-5-5', input: 100_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, DEFAULT_PRICING);
  near(short, (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
  const long = requestCost({ model: 'claude-haiku-5-5', input: 1_000, output: 1_000, cacheRead: 120_000, cacheWrite: 0 }, DEFAULT_PRICING);
  near(long, (1_000 * 0.5 + 1_000 * 2.5 + 120_000 * 0.05) / 1e6);
});

test('a session is priced request by request, so tiers apply', () => {
  const reqs = [
    { id: 'a', t: 1, model: 'claude-haiku-5-5', ctx: 50_000, input: 50_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    { id: 'b', t: 2, model: 'claude-haiku-5-5', ctx: 150_000, input: 150_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
  ];
  const session = {
    events: [],
    usage: { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: { 'claude-haiku-5-5': { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
    requestLog: reqs,
  };
  near(computeStats(session, DEFAULT_PRICING).cost, (50_000 * 0.1 + 150_000 * 0.5) / 1e6);
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-03-10T12:00:00Z');
const base = (extra) => ({ agent: 'Cline', cwd: '/w/app', events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, ...extra });
const run = (s, days = 1) => analyze({ sessions: [{ session: s, file: 'x', agent: 'cline' }], since: NOW - days * DAY, now: NOW, days }, DEFAULT_PRICING);
const req = (t, n) => ({ id: null, t, model: null, ctx: n, input: n, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 });

test('an agent-reported total counts only the part of the session inside the window', () => {
  const s = base({ reportedCost: 10, requestLog: [req(NOW - 3 * DAY, 30_000), req(NOW - 3600_000, 10_000)], events: [{ kind: 'user', t: NOW - 3 * DAY, text: 'hi' }] });
  near(run(s).total.cost, 2.5);
  near(run(s, 7).total.cost, 10);
});

test('usage totals are not added again when the requests fell outside the window', () => {
  const s = base({
    requestLog: [req(NOW - 3 * DAY, 30_000)],
    usage: { input: 30_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    events: [{ kind: 'tool', t: NOW - 3600_000, name: 'Bash', summary: 'ls', isError: false, output: '' }],
  });
  const R = run(s);
  assert.equal(R.total.tokens, 0);
  assert.equal(R.total.toolCalls, 1);
});

test('OpenAI models have prices, with the long-context tier over 272k', () => {
  assert.equal(rateFor('openai/gpt-6.2-sol', DEFAULT_PRICING), DEFAULT_PRICING['gpt-6.2-sol']);
  assert.notEqual(rateFor('gpt-6-astra', DEFAULT_PRICING), DEFAULT_PRICING['gpt-6-astra-law']);
  near(requestCost({ model: 'gpt-6.1-sol', input: 10_000, cacheRead: 100_000, output: 1_000 }, DEFAULT_PRICING), (10_000 * 2 + 100_000 * 0.1 + 1_000 * 10) / 1e6);
  near(requestCost({ model: 'gpt-6.1-sol', input: 10_000, cacheRead: 300_000, output: 1_000 }, DEFAULT_PRICING), (10_000 * 4 + 300_000 * 0.2 + 1_000 * 15) / 1e6);
});
