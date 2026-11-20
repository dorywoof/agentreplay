import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../src/parsers/claude.js';
import * as codex from '../src/parsers/codex.js';
import { detectAgent } from '../src/discover.js';
import { createRedactor, homePattern } from '../src/redact.js';
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

test('scrubs secrets echoed elsewhere without their KEY= prefix', () => {
  const { redact, counts } = createRedactor({ paths: false });
  const out = redact({
    events: [
      { kind: 'tool', input: 'cat .env', output: 'DB_PASSWORD=s3cretPassw0rd99\nPORT=3000' },
      { kind: 'tool', input: 'echo $DB_PASSWORD', output: 's3cretPassw0rd99' },
      { kind: 'assistant', text: 'Connected with s3cretPassw0rd99 — and an OpenAI key sk-proj-abcdefghijklmnopqrstuvwx1234 that I printed raw: abcdefghijklmnopqrstuvwx1234 is not echoed, but sk-proj-abcdefghijklmnopqrstuvwx1234 again is.' },
    ],
  });
  const all = JSON.stringify(out);
  assert.ok(!all.includes('s3cretPassw0rd99'), 'bare echo of the env value is gone');
  assert.ok(!all.includes('sk-proj-abcdefghijklmnopqrstuvwx1234'));
  assert.ok(out.events[0].output.startsWith('DB_PASSWORD=[REDACTED]'));
  assert.ok(out.events[0].output.includes('PORT=3000'), 'non-secret values stay');
  assert.equal(out.events[1].output, '[REDACTED]');
  assert.ok(counts['echoed secret'] >= 2);
});

test('does not treat short or ordinary values as echoed secrets', () => {
  const { redact } = createRedactor({ paths: false });
  const out = redact({ a: 'TOKEN=abc12', b: 'abc12 appears in normal text' });
  assert.equal(out.b, 'abc12 appears in normal text');
});

test('redacts the home path in every spelling a log can hold', () => {
  const B = '\\';
  const p = (sep, ...parts) => parts.join(sep);
  const win = homePattern(p(B, 'C:', 'Users', 'alice'));
  const clean = (s) => s.replace(win, '~');
  assert.equal(clean(p(B, 'C:', 'Users', 'alice', 'proj')), p(B, '~', 'proj'));
  assert.equal(clean(p(B, 'c:', 'users', 'Alice', 'proj')), p(B, '~', 'proj'));
  assert.equal(clean(p(B + B, 'C:', 'Users', 'alice', 'proj')), p(B + B, '~', 'proj'));
  assert.equal(clean(p(B.repeat(4), 'C:', 'Users', 'alice', 'x')), p(B.repeat(4), '~', 'x'));
  assert.equal(clean('C:/Users/alice/proj and /c/Users/alice/x'), '~/proj and ~/x');
  assert.equal(clean(p(B, 'C:', 'Users', 'alice2', 'proj')), p(B, 'C:', 'Users', 'alice2', 'proj'));
  const nix = homePattern('/home/bob');
  assert.equal('/home/bob/src and /home/bobby'.replace(nix, '~'), '~/src and /home/bobby');
});

test('Claude: compaction summaries and task notifications are not prompts; title falls back to first prompt', () => {
  const base = { sessionId: 's', cwd: '/x', timestamp: '2026-01-01T00:00:00Z' };
  const f = tmpJsonl([
    { ...base, type: 'user', uuid: '1', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
    { ...base, type: 'user', uuid: '2', message: { role: 'user', content: '<task-notification><status>done</status></task-notification>' } },
    { ...base, type: 'user', uuid: '3', message: { role: 'user', content: 'add dark mode\nplease' } },
  ]);
  const s = claude.parse(f);
  assert.deepEqual(s.events.map((e) => e.text), ['add dark mode\nplease']);
  assert.equal(s.title, 'add dark mode');
});

test('Codex: plain-text failed tool outputs are marked as errors', () => {
  const ts = '2026-01-01T00:00:00Z';
  const call = (id) => ({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'x()' } });
  const out = (id, text) => ({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }] } });
  const f = tmpJsonl([
    { timestamp: ts, type: 'session_meta', payload: { id: 'z' } },
    call('a'), out('a', 'Script failed\nWall time 0.0 seconds\nOutput:\nTypeError'),
    call('b'), out('b', 'Script completed\nWall time 0.1 seconds\nOutput:\nok'),
    call('c'), out('c', 'Process exited with code 2\nOutput:\nnope'),
  ]);
  const s = codex.parse(f);
  assert.deepEqual(s.events.filter((e) => e.kind === 'tool').map((e) => e.isError), [true, false, true]);
});

test('npm, GitLab and Hugging Face tokens are redacted', async () => {
  const { createRedactor } = await import('../src/redact.js');
  // Built at run time so secret scanners don't mistake these fakes for real tokens.
  const fake = (prefix, body) => prefix + body;
  const out = createRedactor({}).redact({
    a: `//registry.npmjs.org/:_authToken=${fake('npm_', 'abcdefghijklmnopqrstuvwxyz0123456789')}`,
    b: fake('glpat-', 'abcdefghij1234567890'),
    c: fake('hf_', 'abcdefghijklmnopqrstuvwxyzABCDEFGH'),
  });
  assert.ok(!out.a.includes('npm_abc'), out.a);
  assert.ok(!out.b.includes('glpat-'), out.b);
  assert.ok(!out.c.includes('hf_abc'), out.c);
});

test('encoded copies of a known secret are redacted: URL-encoded and base64 at any offset', async () => {
  const { createRedactor } = await import('../src/redact.js');
  const secret = ['aB3+dE/fG9', '=hJ2kL5mN8pQ'].join('');
  const b64 = (s) => Buffer.from(s).toString('base64');
  const input = {
    assign: `MY_API_KEY=${secret}`,
    url: `curl "https://x.io/?k=${encodeURIComponent(secret)}"`,
    off0: `blob ${b64(secret)} end`,
    off1: `blob ${b64('u' + secret + 'x')} end`,
    off2: `blob ${b64('us:' + secret)} end`,
    urlSafe: `t=${b64('ab' + secret).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
    unrelated: `sha ${b64('nothing secret in here at all, just data')}`,
  };
  const out = createRedactor({}).redact(input);
  for (const k of ['url', 'off0', 'off1', 'off2', 'urlSafe']) assert.match(out[k], /\[REDACTED\]/, `${k}: ${out[k]}`);
  assert.equal(out.unrelated, input.unrelated);
  assert.equal(out.off0, 'blob [REDACTED] end');
});

test('hex copies of a known secret are redacted: contiguous, separated, and inside xxd / hexdump -C dumps', async () => {
  const { createRedactor } = await import('../src/redact.js');
  const secret = ['Zq7wV2', 'nR8tY4', 'pL1xK6'].join('');
  const body = Buffer.from(`{"user":"bob","key":"${secret}","n":1}`);
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0'));
  const ascii = (b) => [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
  const rows = (b, fn) => {
    const out = [];
    for (let i = 0; i < b.length; i += 16) out.push(fn(b.subarray(i, i + 16), i));
    return out.join('\n');
  };
  const xxd = rows(body, (r, i) => {
    const h = hex(r);
    const groups = [];
    for (let j = 0; j < h.length; j += 2) groups.push(h.slice(j, j + 2).join(''));
    return `${i.toString(16).padStart(8, '0')}: ${groups.join(' ').padEnd(39)}  ${ascii(r)}`;
  });
  const hexdumpC = rows(body, (r, i) => {
    const h = hex(r);
    return `${i.toString(16).padStart(8, '0')}  ${h.slice(0, 8).join(' ')}  ${h.slice(8).join(' ')}  |${ascii(r)}|`;
  });
  const s = Buffer.from(secret);
  const input = {
    assign: `MY_API_KEY=${secret}`,
    lower: `body=${hex(s).join('')}`,
    upper: `BODY=${hex(s).join('').toUpperCase()}`,
    spaced: `bytes: ${hex(s).join(' ')}`,
    escaped: `printf '${hex(s).map((h) => '\\x' + h).join('')}'`,
    cArray: `{ ${hex(s).map((h) => '0x' + h).join(', ')} }`,
    plain: hex(body).join('').match(/.{1,60}/g).join('\n'),
    xxd,
    hexdumpC,
    jsonEscaped: JSON.stringify(xxd).slice(1, -1),
    unrelated: `sha256 ${hex(Buffer.from('nothing secret in here at all')).join('')}`,
  };
  const out = createRedactor({}).redact(input);
  const secretHex = hex(s).join('');
  for (const k of Object.keys(input).filter((k) => k !== 'unrelated' && k !== 'assign')) {
    assert.match(out[k], /\[REDACTED\]/, `${k}: ${out[k]}`);
    const leftover = out[k].replace(/[^0-9a-f]/gi, '').toLowerCase();
    assert.ok(!leftover.includes(secretHex.slice(0, 16)), `${k} still holds the start of the secret: ${out[k]}`);
  }
  assert.equal(out.lower, 'body=[REDACTED]');
  assert.equal(out.unrelated, input.unrelated);
});

test('a Basic auth header is redacted even when the secret was never seen elsewhere', async () => {
  const { createRedactor } = await import('../src/redact.js');
  const header = `Authorization: Basic ${Buffer.from(['bob', ':', 'p4ss', 'w0rd', '1234'].join('')).toString('base64')}`;
  assert.equal(createRedactor({}).redact(header), 'Authorization: Basic [REDACTED]');
});
