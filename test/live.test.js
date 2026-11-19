import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusLine, promptGuard, lastRequest, resendCost } from '../src/live.js';
import { setup, unsetup, commandFor } from '../src/setup.js';
import { DEFAULT_PRICING } from '../src/pricing.js';

const BIN = fileURLToPath(new URL('../bin/agentreplayer.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/demo-session.jsonl', import.meta.url));
const T0 = Date.parse('2026-03-02T10:00:00Z');
const MIN = 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ar-live-'));

function transcript(ctx, { t = T0, oneHour = false } = {}) {
  const f = path.join(tmp(), 's.jsonl');
  const usage = { input_tokens: 10, cache_read_input_tokens: ctx - 1010, cache_creation_input_tokens: 1000, output_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: oneHour ? 1000 : 0, ephemeral_5m_input_tokens: oneHour ? 0 : 1000 } };
  const lines = [
    { type: 'user', timestamp: new Date(t - MIN).toISOString(), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', timestamp: new Date(t).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage } },
    { type: 'assistant', timestamp: new Date(t + 1000).toISOString(), message: { model: '<synthetic>', usage: { input_tokens: 0 } } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('reads the last real request from the transcript tail', () => {
  const r = lastRequest(transcript(120_000, { oneHour: true }));
  assert.equal(r.ctx, 120_000);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.t, T0);
  assert.equal(r.ttlMs, 60 * MIN);
  assert.equal(lastRequest('/no/such/file'), null);
});

test('status line: cost, context size, warm per-message cost and the long-session hint', () => {
  const f = transcript(160_000);
  const line = statusLine({ transcript_path: f, model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 3.2 } }, DEFAULT_PRICING, { now: T0 + MIN, color: false });
  assert.equal(line, '$3.20 · 160k ctx · each msg ~$0.03 · ⚠ long session: /clear or a new one saves money');
});

test('status line: a cold cache shows what the next message costs', () => {
  const f = transcript(140_000);
  const line = statusLine({ transcript_path: f, model: { id: 'claude-opus-5-5' } }, DEFAULT_PRICING, { now: T0 + 12 * MIN, color: false });
  assert.match(line, /❄ cache cold \(12m idle\): next msg ~\$0\.70/);
  // Claude Code's own cache state wins over our clock.
  const warm = statusLine({ transcript_path: f, model: { id: 'claude-opus-5-5' }, prompt_cache: { warm: true, requests: 3 } }, DEFAULT_PRICING, { now: T0 + 12 * MIN, color: false });
  assert.doesNotMatch(warm, /cold/);
  assert.equal(statusLine({}, DEFAULT_PRICING, { color: false }), '');
});

test('prompt guard blocks once per cold spell, and only for big conversations', () => {
  const dir = tmp();
  const f = transcript(140_000);
  const input = { transcript_path: f, session_id: 'abc' };
  assert.equal(promptGuard(input, DEFAULT_PRICING, { now: T0 + 2 * MIN, dir }), null, 'warm cache: no block');
  const first = promptGuard(input, DEFAULT_PRICING, { now: T0 + 12 * MIN, dir });
  assert.ok(first?.block);
  assert.match(first.reason, /expired after 12m idle.*140k-token/s);
  assert.equal(promptGuard(input, DEFAULT_PRICING, { now: T0 + 13 * MIN, dir }), null, 'sending again goes through');
  assert.equal(promptGuard({ ...input, agent_id: 'sub' }, DEFAULT_PRICING, { now: T0 + 12 * MIN, dir: tmp() }), null, 'subagents are never blocked');
  assert.equal(promptGuard({ transcript_path: transcript(20_000), session_id: 'small' }, DEFAULT_PRICING, { now: T0 + 30 * MIN, dir }), null, 'small context: not worth it');
  assert.equal(promptGuard({ transcript_path: transcript(140_000, { oneHour: true }), session_id: 'h' }, DEFAULT_PRICING, { now: T0 + 30 * MIN, dir }), null, '1h cache still warm');
});

test('resend cost: cold write vs warm read', () => {
  const c = resendCost(100_000, 'claude-opus-5-5', DEFAULT_PRICING);
  assert.equal(c.cold.toFixed(2), '0.50');
  assert.equal(c.warm.toFixed(2), '0.02');
  assert.equal(resendCost(100_000, 'mystery', DEFAULT_PRICING), null);
});

test('setup adds our entries, keeps everything else, and removes cleanly', () => {
  const file = path.join(tmp(), 'settings.json');
  const foreign = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool run' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] }, theme: 'dark' };
  fs.writeFileSync(file, JSON.stringify(foreign));
  const bin = 'C:\\tools\\agentreplayer\\bin\\agentreplayer.js';
  const res = setup({ file, nodePath: 'C:\\node\\node.exe', binPath: bin });
  assert.deepEqual(res.map((r) => r.status), ['added', 'added', 'added']);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.statusLine.command, '"C:/node/node.exe" "C:/tools/agentreplayer/bin/agentreplayer.js" statusline');
  assert.equal(s.statusLine.refreshInterval, 30);
  assert.equal(s.hooks.UserPromptSubmit.length, 2, 'the other tool stays');
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 30);
  assert.equal(s.theme, 'dark');
  assert.ok(fs.existsSync(file + '.agentreplayer-backup'));
  // Running it again doesn't duplicate.
  setup({ file, nodePath: 'C:\\node\\node.exe', binPath: bin });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.UserPromptSubmit.length, 2);
  assert.equal(s.hooks.SessionEnd.length, 1);
  // Remove: back to the original content.
  unsetup({ file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), foreign);
});

test('setup never replaces somebody else’s status line without --force', () => {
  const file = path.join(tmp(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' } }));
  const res = setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js', parts: ['statusline'] });
  assert.equal(res[0].status, 'skipped');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-line.sh');
  assert.equal(setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js', parts: ['statusline'], force: true })[0].status, 'updated');
  assert.throws(() => {
    fs.writeFileSync(file, '{ broken');
    setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js' });
  }, /not valid JSON/);
  assert.match(commandFor('node', 'a b/agentreplayer.js', 'statusline'), /^"node" "a b\/agentreplayer.js" statusline$/);
});

test('CLI: statusline never fails, session-end saves a replay and reports via stderr + exit 2', () => {
  const sl = spawnSync(process.execPath, [BIN, 'statusline'], { input: 'not json', encoding: 'utf8' });
  assert.equal(sl.status, 0);
  const home = tmp();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const end = spawnSync(process.execPath, [BIN, 'hook', 'session-end'], { input: JSON.stringify({ transcript_path: DEMO, reason: 'prompt_input_exit' }), encoding: 'utf8', env });
  assert.equal(end.status, 2, end.stderr);
  assert.match(end.stderr, /agentreplayer: .*tool calls/);
  const saved = fs.readdirSync(path.join(home, '.agentreplayer', 'replays'));
  assert.equal(saved.length, 1);
  const resumed = spawnSync(process.execPath, [BIN, 'hook', 'session-end'], { input: JSON.stringify({ transcript_path: DEMO, reason: 'resume' }), encoding: 'utf8', env });
  assert.equal(resumed.status, 0);
});
