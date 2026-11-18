import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../src/parsers/claude.js';
import * as codex from '../src/parsers/codex.js';
import { detectAgent } from '../src/discover.js';
import { createRedactor } from '../src/redact.js';
import { computeStats } from '../src/stats.js';
import { DEFAULT_PRICING, estimateCost } from '../src/pricing.js';
import { renderHtml } from '../src/render.js';

const DEMO = fileURLToPath(new URL('../examples/demo-session.jsonl', import.meta.url));

function tmpJsonl(records) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 's.jsonl');
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n'));
  return f;
}

test('parses the Claude Code demo session', () => {
  const s = claude.parse(DEMO);
  assert.equal(s.title, 'Add a dark mode toggle to the todo app');
  assert.deepEqual(s.models, ['claude-opus-5-5']);
  const tools = s.events.filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 10);
  assert.equal(tools.filter((t) => t.isError).length, 1, 'failed test run is marked as an error');
  assert.ok(tools.every((t) => t.endT), 'every tool call got its result');
});

test('counts usage once per API message, not per content block', () => {
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const base = { type: 'assistant', sessionId: 'x', timestamp: '2026-01-01T00:00:00Z' };
  const f = tmpJsonl([
    { ...base, message: { id: 'm1', model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text: 'a' }] } },
    { ...base, message: { id: 'm1', model: 'claude-opus-5-5', usage: u, content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
  ]);
  const s = claude.parse(f);
  assert.equal(s.usage.input, 10);
  assert.equal(s.usage.output, 5);
});

test('strips system reminders and skips meta prompts', () => {
  const base = { type: 'user', sessionId: 'x', timestamp: '2026-01-01T00:00:00Z' };
  const f = tmpJsonl([
    { ...base, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>secret context</system-reminder>' }, { type: 'text', text: 'fix the bug' }] } },
    { ...base, isMeta: true, message: { role: 'user', content: 'meta stuff' } },
  ]);
  const s = claude.parse(f);
  assert.deepEqual(s.events.map((e) => e.text), ['fix the bug']);
});

test('parses a Codex rollout with apply_patch and token totals', () => {
  const ts = '2026-01-01T00:00:00Z';
  const f = tmpJsonl([
    { timestamp: ts, type: 'session_meta', payload: { id: 'abc', cwd: '/repo' } },
    { timestamp: ts, type: 'turn_context', payload: { model: 'gpt-x', cwd: '/repo' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rename foo' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"output":"a.js\\n","metadata":{"exit_code":1}}' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: a.js\n@@\n-foo()\n+bar()\n*** End Patch' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } } } },
  ]);
  assert.equal(detectAgent(f), 'codex');
  const s = codex.parse(f);
  assert.equal(s.events.filter((e) => e.kind === 'user').length, 1, 'environment context is hidden');
  const [shell, patch] = s.events.filter((e) => e.kind === 'tool');
  assert.equal(shell.summary, 'ls');
  assert.equal(shell.isError, true);
  assert.equal(shell.output, 'a.js');
  assert.equal(patch.file, 'a.js');
  assert.deepEqual(patch.lines, { added: 1, removed: 1 });
  assert.equal(s.usage.input, 400);
  assert.equal(s.usage.cacheRead, 600);
});

test('redacts secrets but leaves ordinary code alone', () => {
  const { redact, counts } = createRedactor({ paths: false });
  const out = redact({
    a: 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    b: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    c: 'local token = entry.Token + 1',
    d: 'DATABASE_PASSWORD="hunter2hunter2"',
    e: 'mail me at someone@company.io',
    f: 'curl https://user:p4ssw0rd@example.com/x',
  });
  assert.ok(!out.a.includes('sk-ant-api03'));
  assert.ok(!out.b.includes('ghp_'));
  assert.equal(out.c, 'local token = entry.Token + 1');
  assert.ok(out.d.includes('[REDACTED]') && out.d.startsWith('DATABASE_PASSWORD='));
  assert.equal(out.e, 'mail me at [email]');
  assert.ok(!out.f.includes('p4ssw0rd'));
  assert.ok(Object.keys(counts).length >= 4);
});

test('redacts the home directory', () => {
  const { redact } = createRedactor();
  assert.equal(redact(path.join(os.homedir(), 'proj', 'a.js')), path.join('~', 'proj', 'a.js'));
});

test('estimates cost and returns null for unknown models', () => {
  const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  assert.equal(estimateCost({ 'claude-opus-5-5': u }, DEFAULT_PRICING), 24);
  assert.equal(estimateCost({ 'some-other-model': u }, DEFAULT_PRICING), null);
});

test('renders HTML that cannot be broken out of by session text', () => {
  const s = claude.parse(DEMO);
  s.events.push({ kind: 'assistant', t: Date.now(), text: '</script><script>alert(1)</script>' });
  const html = renderHtml(s, computeStats(s, DEFAULT_PRICING));
  const data = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!data.includes('<'));
  assert.equal(JSON.parse(data).events.at(-1).text, '</script><script>alert(1)</script>');
});

test('stats count changed files and lines', () => {
  const s = claude.parse(DEMO);
  const st = computeStats(s, DEFAULT_PRICING);
  assert.equal(st.files.length, 4);
  assert.ok(st.linesAdded > 30);
  assert.equal(st.errors, 1);
  assert.ok(st.cost > 0);
});
