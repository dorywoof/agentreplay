import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workClock, buildLane, renderRace, resolveRef, IDLE_CAP_MS } from '../src/race.js';
import { DEFAULT_PRICING } from '../src/pricing.js';

const T0 = Date.parse('2026-03-02T10:00:00Z');
const S = 1000;
const BIN = fileURLToPath(new URL('../bin/agentreplay.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/demo-session.jsonl', import.meta.url));

test('working clock caps idle gaps the same way for every lane', () => {
  const at = workClock([T0, T0 + 30 * S, T0 + 30 * S + 60 * 60 * S, NaN]);
  assert.equal(at(T0), 0);
  assert.equal(at(T0 + 30 * S), 30 * S);
  assert.equal(at(T0 + 30 * S + 60 * 60 * S), 30 * S + IDLE_CAP_MS);
  assert.equal(at(null), null);
});

test('a lane carries events on its own clock and running token totals', () => {
  const session = {
    agent: 'Codex',
    title: 'add login',
    models: ['m'],
    events: [
      { kind: 'user', t: T0, text: 'add login' },
      { kind: 'tool', t: T0 + 10 * S, endT: T0 + 12 * S, name: 'exec', summary: 'npm test', isError: true },
      { kind: 'assistant', t: null, text: 'done' },
    ],
    requestLog: [{ t: T0 + 5 * S, model: 'mystery', ctx: 1000, input: 1000, cacheRead: 0, cacheWrite: 0, output: 50 }],
    usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: { mystery: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
  };
  const lane = buildLane(session, DEFAULT_PRICING);
  assert.deepEqual(lane.events.map((e) => e.at), [0, 10 * S, 10 * S]);
  assert.ok(!('t' in lane.events[0]), 'absolute timestamps are not shipped');
  assert.equal(lane.timed, true);
  assert.deepEqual(lane.reqs, [{ at: 5 * S, tokens: 1050, cost: null }]);
  assert.equal(lane.final.errors, 1);
  assert.equal(lane.final.cost, null);
});

test('race HTML keeps session text inside the data block', () => {
  const lane = buildLane({ agent: 'A', title: '</script><img src=x onerror=alert(1)>', models: [], events: [{ kind: 'user', t: T0, text: '</script>' }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, usageByModel: {} }, DEFAULT_PRICING);
  const html = renderRace([lane, { ...lane, agent: 'B' }]);
  assert.equal(html.split('</script>').length - 1, 2, 'only the template’s two script tags close');
  assert.ok(html.includes('--bg:'), 'theme CSS is inlined');
  assert.match(html, /<title>A vs B · agentreplay race<\/title>/);
});

test('lane refs: files and unknown names', () => {
  assert.equal(resolveRef(DEMO).agent, 'claude');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-race-'));
  assert.throws(() => resolveRef(dir), /not a file, a --list number or an agent/);
  assert.throws(() => resolveRef('nope'), /not a file/);
});

test('CLI race writes a page and rejects bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-race-'));
  const other = path.join(dir, 'other.jsonl');
  fs.copyFileSync(DEMO, other);
  const out = path.join(dir, 'race.html');
  const ok = spawnSync(process.execPath, [BIN, 'race', DEMO, other, '-o', out, '--no-open'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /race · Claude Code vs Claude Code/);
  assert.ok(fs.readFileSync(out, 'utf8').includes('agentreplay race'));
  const same = spawnSync(process.execPath, [BIN, 'race', DEMO, DEMO, '--no-open'], { encoding: 'utf8' });
  assert.match(same.stderr, /same session/);
  const one = spawnSync(process.execPath, [BIN, 'race', DEMO, '--no-open'], { encoding: 'utf8' });
  assert.match(one.stderr, /needs two sessions/);
});
