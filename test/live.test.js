import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusLine, promptGuard, lastRequest, resendCost, combineLines, visibleWidth, shellFor } from '../src/live.js';
import { setup, unsetup, commandFor, readWrapped, wrapFile } from '../src/setup.js';
import { readToday, refreshToday, localDay } from '../src/today.js';
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
  assert.equal(line, '$3.20 · 160k ctx · each msg ~$0.03 · long session: /clear saves money');
});

test('status line: a cold cache shows what the next message costs', () => {
  const f = transcript(140_000);
  const line = statusLine({ transcript_path: f, model: { id: 'claude-opus-5-5' } }, DEFAULT_PRICING, { now: T0 + 12 * MIN, color: false });
  assert.match(line, /cache cold 12m: next msg ~\$0\.70/);
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

test('setup wraps somebody else’s status line, and --remove puts it back exactly', () => {
  const file = path.join(tmp(), 'settings.json');
  const theirs = { type: 'command', command: 'my-line.sh', padding: 1, refreshInterval: 10 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: theirs }));
  const res = setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js', parts: ['statusline'] });
  assert.equal(res[0].status, 'added');
  assert.match(res[0].note, /kept your status line/);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.statusLine.command, '"node" "/x/agentreplayer.js" statusline --wrap');
  assert.equal(s.statusLine.padding, 1, 'their padding is kept');
  assert.equal(s.statusLine.refreshInterval, 10, 'their faster refresh is kept');
  assert.deepEqual(readWrapped(wrapFile(file)), theirs);
  // Running setup again keeps wrapping instead of wrapping ourselves.
  setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js', parts: ['statusline'] });
  assert.deepEqual(readWrapped(wrapFile(file)), theirs);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, /statusline --wrap$/);
  const removed = unsetup({ file });
  assert.match(removed[0].note, /your own status line is back/);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.statusLine, theirs);
  assert.ok(!fs.existsSync(wrapFile(file)));
  // --force replaces instead of wrapping.
  const forced = setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js', parts: ['statusline'], force: true });
  assert.match(forced[0].note, /replaced/);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, /statusline$/);
  assert.throws(() => {
    fs.writeFileSync(file, '{ broken');
    setup({ file, nodePath: 'node', binPath: '/x/agentreplayer.js' });
  }, /not valid JSON/);
  assert.match(commandFor('node', 'a b/agentreplayer.js', 'statusline'), /^"node" "a b\/agentreplayer.js" statusline$/);
});

test('CLI: statusline never fails, session-end saves a replay and reports via systemMessage with exit 0 (no hook error)', () => {
  const home = tmp();
  // An isolated home: the status line kicks off a background "today" refresh that writes there.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const sl = spawnSync(process.execPath, [BIN, 'statusline'], { input: 'not json', encoding: 'utf8', env });
  assert.equal(sl.status, 0);
  const end = spawnSync(process.execPath, [BIN, 'hook', 'session-end'], { input: JSON.stringify({ transcript_path: DEMO, reason: 'prompt_input_exit' }), encoding: 'utf8', env });
  assert.equal(end.status, 0, end.stderr);
  assert.match(JSON.parse(end.stdout).systemMessage, /agentreplayer: .*tool calls/);
  const saved = fs.readdirSync(path.join(home, '.agentreplayer', 'replays'));
  assert.equal(saved.length, 1);
  const resumed = spawnSync(process.execPath, [BIN, 'hook', 'session-end'], { input: JSON.stringify({ transcript_path: DEMO, reason: 'resume' }), encoding: 'utf8', env });
  assert.equal(resumed.status, 0);
  assert.equal(resumed.stdout, '');
  const sub = spawnSync(process.execPath, [BIN, 'hook', 'session-end'], { input: JSON.stringify({ transcript_path: DEMO, reason: 'other', agent_id: 'a1' }), encoding: 'utf8', env });
  assert.equal(sub.stdout, '');
  assert.equal(fs.readdirSync(path.join(home, '.agentreplayer', 'replays')).length, 1);
});

test('subscription: limits first, dollars become an API estimate, advice talks about the limit', () => {
  const f = transcript(160_000);
  const now = T0 + MIN;
  const input = {
    transcript_path: f,
    model: { id: 'claude-opus-5-5' },
    cost: { total_cost_usd: 20 },
    rate_limits: { five_hour: { used_percentage: 82.4, resets_at: (now + 90 * MIN) / 1000 }, seven_day: { used_percentage: 18 } },
  };
  assert.equal(statusLine(input, DEFAULT_PRICING, { now, color: false }), '5h 82% (resets 1h30m) · 7d 18% · ~$20 API · 160k ctx · long session: /clear saves limit');
});

test('status line drops the least useful pieces to fit the terminal, never the context size', () => {
  const f = transcript(160_000);
  const input = { transcript_path: f, model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 3.2 } };
  const today = { cost: 41.5, tokens: 1e6 };
  const full = statusLine(input, DEFAULT_PRICING, { now: T0 + MIN, color: false, today });
  assert.equal(full, '$3.20 · today ~$42 · 160k ctx · each msg ~$0.03 · long session: /clear saves money');
  const narrow = statusLine(input, DEFAULT_PRICING, { now: T0 + MIN, color: true, today, width: 30 });
  assert.ok(visibleWidth(narrow) <= 30, narrow);
  assert.match(narrow, /160k ctx/);
  assert.doesNotMatch(narrow, /each msg/);
});

test('no emoji or ambiguous-width symbols in the status line', () => {
  const lines = [
    statusLine({ transcript_path: transcript(160_000), model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 1 } }, DEFAULT_PRICING, { now: T0 + MIN, color: false }),
    statusLine({ transcript_path: transcript(160_000), model: { id: 'claude-opus-5-5' } }, DEFAULT_PRICING, { now: T0 + 20 * MIN, color: false }),
  ];
  for (const l of lines) assert.match(l, /^[\x20-\x7e·]+$/, l);
});

test('wrapping: ours goes on their last row when it fits, else on its own row', () => {
  assert.equal(combineLines('model | main\n', 'ours', 80), 'model | main | ours');
  assert.equal(combineLines('a very long status line', 'ours', 20), 'a very long status line\nours');
  assert.equal(combineLines('row1\nrow2', 'ours', null), 'row1\nrow2\nours');
  assert.equal(combineLines('', 'ours', 80), 'ours');
  assert.equal(combineLines('\x1b[32mgreen\x1b[0m', 'ours', 14), '\x1b[32mgreen\x1b[0m | ours');
  const [bash] = shellFor('x', { platform: 'win32', env: {}, exists: (p) => p === 'C:/Program Files/Git/bin/bash.exe' });
  assert.equal(bash, 'C:/Program Files/Git/bin/bash.exe');
  assert.deepEqual(shellFor('x', { platform: 'win32', env: {}, exists: () => false })[1].slice(0, 2), ['-NoProfile', '-NonInteractive']);
  assert.deepEqual(shellFor('x', { platform: 'linux', env: { SHELL: '/bin/zsh' } }), ['/bin/zsh', ['-c', 'x']]);
});

test('today cache: fresh, stale and from another day', () => {
  const dir = tmp();
  assert.deepEqual(readToday({ dir }), { stale: true, value: null });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'today.json'), JSON.stringify({ day: localDay(now), at: now, cost: 5 }));
  assert.equal(readToday({ dir, now }).stale, false);
  assert.equal(readToday({ dir, now: now + 3 * MIN }).stale, true);
  fs.writeFileSync(path.join(dir, 'today.json'), JSON.stringify({ day: '2000-01-01', at: now, cost: 5 }));
  assert.equal(readToday({ dir, now }).value, null);
});

test('CLI statusline --wrap runs the wrapped command and adds ours', () => {
  const home = tmp();
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  const script = path.join(home, 'theirs.js');
  fs.writeFileSync(script, 'process.stdout.write("THEIRS" + String.fromCharCode(10))');
  const slash = (p) => p.split(path.sep).join('/');
  const cmd = `"${slash(process.execPath)}" "${slash(script)}"`;
  fs.writeFileSync(path.join(cfg, 'agentreplayer-statusline.json'), JSON.stringify({ type: 'command', command: cmd }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, COLUMNS: '120', NO_COLOR: '1' };
  const r = spawnSync(process.execPath, [BIN, 'statusline', '--wrap'], { input: JSON.stringify({ cost: { total_cost_usd: 1.5 } }), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'THEIRS | $1.50');
});

test('doctor reports the setup and the shape of the last status line input, never its values', () => {
  const home = tmp();
  const cfg = path.join(home, '.claude');
  const tmpdir = tmp();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, TMP: tmpdir, TEMP: tmpdir, TMPDIR: tmpdir, NO_COLOR: '1' };
  const before = spawnSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8', env });
  assert.match(before.stdout, /hasn't run yet/);
  const input = { version: '2.1.328', model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 1 }, transcript_path: 'C:/secret/path.jsonl' };
  spawnSync(process.execPath, [BIN, 'statusline'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const note = fs.readFileSync(path.join(tmpdir, 'agentreplayer', 'statusline-last.json'), 'utf8');
  assert.doesNotMatch(note, /secret/, 'only field names are stored');
  const after = spawnSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8', env });
  assert.match(after.stdout, /Claude Code 2\.1\.328/);
  assert.match(after.stdout, /did not send rate_limits/);
  spawnSync(process.execPath, [BIN, 'statusline'], { input: JSON.stringify({ ...input, rate_limits: { five_hour: { used_percentage: 10 } } }), encoding: 'utf8', env });
  assert.match(spawnSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8', env }).stdout, /subscription limits: five_hour/);
});
