// One small fixture per supported format, built in a temp dir so the repo stays clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARSERS, detectAgent } from '../src/discover.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-formats-'));
function put(rel, data) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : Array.isArray(data) && rel.endsWith('.jsonl') ? data.map((d) => JSON.stringify(d)).join('\n') : JSON.stringify(data));
  return f;
}
const kinds = (s) => s.events.map((e) => e.kind).join(',');
const tools = (s) => s.events.filter((e) => e.kind === 'tool');

test('Gemini CLI session JSON', () => {
  const f = put('.gemini/tmp/abc/chats/session-1.json', {
    sessionId: 'g1',
    startTime: '2026-11-01T10:00:00Z',
    messages: [
      { id: '1', timestamp: '2026-11-01T10:00:00Z', type: 'user', content: 'add a README' },
      {
        id: '2', timestamp: '2026-11-01T10:00:05Z', type: 'gemini', content: 'Creating it now.', model: 'gemini-3-pro',
        thoughts: [{ subject: 'Plan', description: 'write a short README' }],
        toolCalls: [{ id: 'c1', name: 'write_file', args: { file_path: 'README.md', content: '# Hello\nworld' }, result: [{ functionResponse: { name: 'write_file', response: { output: 'ok' } } }], status: 'success' }],
        tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, total: 1060 },
      },
      { id: '3', timestamp: '2026-11-01T10:00:06Z', type: 'info', content: 'saved' },
    ],
  });
  assert.equal(detectAgent(f), 'gemini');
  const s = PARSERS.gemini.parse(f);
  assert.equal(kinds(s), 'user,thinking,assistant,tool');
  const [w] = tools(s);
  assert.equal(w.file, 'README.md');
  assert.equal(w.output, 'ok');
  assert.deepEqual(s.models, ['gemini-3-pro']);
  assert.equal(s.usage.input, 600);
  assert.equal(s.usage.cacheRead, 400);
  assert.equal(s.usage.output, 60);
});

test('Qwen Code JSONL (Gemini parts)', () => {
  const f = put('.qwen/projects/p/chats/s.jsonl', [
    { uuid: 'a', sessionId: 'q1', timestamp: '2026-11-01T10:00:00Z', type: 'user', message: { role: 'user', parts: [{ text: 'list files' }] } },
    { uuid: 'b', timestamp: '2026-11-01T10:00:02Z', type: 'assistant', model: 'qwen3-coder', message: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { functionCall: { name: 'list_directory', args: { path: '.' } } }] }, usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, cachedContentTokenCount: 100 } },
    { uuid: 'c', timestamp: '2026-11-01T10:00:03Z', type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { name: 'list_directory', response: { output: 'a.txt\nb.txt' } } }] } },
    { uuid: 'd', timestamp: '2026-11-01T10:00:04Z', type: 'assistant', message: { role: 'model', parts: [{ text: 'Two files.' }] } },
  ]);
  assert.equal(detectAgent(f), 'qwen');
  const s = PARSERS.qwen.parse(f);
  assert.equal(kinds(s), 'user,thinking,tool,assistant');
  assert.equal(tools(s)[0].output, 'a.txt\nb.txt');
  assert.equal(s.usage.input, 400);
});

test('Cline task folder (XML tools, ui_messages usage)', () => {
  const dir = 'Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1730000000000';
  const f = put(`${dir}/api_conversation_history.json`, [
    { role: 'user', content: [{ type: 'text', text: '<task>\nfix the typo in app.js\n</task>' }, { type: 'text', text: '<environment_details>lots of stuff</environment_details>' }] },
    { role: 'assistant', content: [{ type: 'text', text: '<thinking>find it first</thinking>\nLet me fix it.\n<replace_in_file>\n<path>app.js</path>\n<diff>\n<<<<<<< SEARCH\nconsle.log(1)\n=======\nconsole.log(1)\n>>>>>>> REPLACE\n</diff>\n</replace_in_file>' }] },
    { role: 'user', content: [{ type: 'text', text: "[replace_in_file for 'app.js'] Result:\nThe content was successfully saved to app.js." }] },
    { role: 'assistant', content: [{ type: 'text', text: '<attempt_completion>\n<result>Fixed the typo.</result>\n</attempt_completion>' }] },
  ]);
  put(`${dir}/ui_messages.json`, [
    { ts: 1730000000000, type: 'say', say: 'task', text: 'fix the typo in app.js' },
    { ts: 1730000003000, type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 1200, tokensOut: 80, cacheReads: 300, cacheWrites: 50, cost: 0.0123 }) },
    { ts: 1730000009000, type: 'say', say: 'completion_result', text: 'Fixed the typo.' },
  ]);
  assert.equal(detectAgent(f), 'cline');
  const s = PARSERS.cline.parse(f);
  assert.equal(s.events[0].text, 'fix the typo in app.js');
  assert.equal(kinds(s), 'user,thinking,assistant,tool,assistant');
  const [edit] = tools(s);
  assert.equal(edit.file, 'app.js');
  assert.deepEqual(edit.lines, { added: 1, removed: 1 });
  assert.match(edit.output, /successfully saved/);
  assert.equal(s.reportedCost, 0.0123);
  assert.equal(s.usage.input, 1200);
  assert.equal(s.events.at(-1).t, 1730000009000);
});

test('Cline/Roo native tool_use blocks (Anthropic format)', () => {
  const f = put('Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/t2/api_conversation_history.json', [
    { role: 'user', content: 'run the tests', ts: 1730000000000 },
    { role: 'assistant', ts: 1730000001000, content: [{ type: 'tool_use', id: 'tu1', name: 'execute_command', input: { command: 'npm test' } }] },
    { role: 'user', ts: 1730000002000, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '3 passing' }] }] },
  ]);
  assert.equal(detectAgent(f), 'roo');
  const s = PARSERS.roo.parse(f);
  assert.equal(s.agent, 'Roo Code');
  assert.equal(tools(s)[0].summary, 'npm test');
  assert.equal(tools(s)[0].output, '3 passing');
});

test('OpenCode storage tree', () => {
  const st = 'opencode/storage';
  const f = put(`${st}/session/proj1/ses_1.json`, { id: 'ses_1', title: 'Rename helper', directory: '/repo', time: { created: 1730000000000 } });
  put(`${st}/message/ses_1/msg_1.json`, { id: 'msg_1', sessionID: 'ses_1', role: 'user', time: { created: 1730000000000 } });
  put(`${st}/message/ses_1/msg_2.json`, { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: { created: 1730000001000 }, modelID: 'claude-sonnet-5-5', providerID: 'anthropic', cost: 0.02, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } } });
  put(`${st}/part/msg_1/prt_1.json`, { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'rename foo to bar' });
  put(`${st}/part/msg_2/prt_1.json`, { id: 'prt_1', messageID: 'msg_2', type: 'step-start' });
  put(`${st}/part/msg_2/prt_2.json`, { id: 'prt_2', messageID: 'msg_2', type: 'reasoning', text: 'simple rename' });
  put(`${st}/part/msg_2/prt_3.json`, { id: 'prt_3', messageID: 'msg_2', type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { filePath: 'a.ts', oldString: 'foo()', newString: 'bar()' }, output: 'done', time: { start: 1730000001500, end: 1730000002000 } } });
  put(`${st}/part/msg_2/prt_4.json`, { id: 'prt_4', messageID: 'msg_2', type: 'text', text: 'Renamed.' });
  assert.equal(detectAgent(f), 'opencode');
  const s = PARSERS.opencode.parse(f);
  assert.equal(s.title, 'Rename helper');
  assert.equal(kinds(s), 'user,thinking,tool,assistant');
  assert.equal(tools(s)[0].file, 'a.ts');
  assert.equal(s.reportedCost, 0.02);
  assert.equal(s.usage.cacheRead, 1000);
  assert.equal(s.usage.output, 25);
});

test('OpenCode export JSON', () => {
  const f = put('exports/opencode-session.json', {
    info: { id: 'ses_9', title: 'Exported', directory: '/x' },
    messages: [
      { info: { id: 'm1', role: 'user', time: { created: 1730000000000 } }, parts: [{ type: 'text', text: 'hello' }] },
      { info: { id: 'm2', role: 'assistant', time: { created: 1730000001000 }, modelID: 'gpt-x' }, parts: [{ type: 'text', text: 'hi!' }] },
    ],
  });
  const s = PARSERS.opencode.parse(f);
  assert.equal(kinds(s), 'user,assistant');
  assert.equal(s.title, 'Exported');
});

test('Copilot CLI events.jsonl', () => {
  const f = put('.copilot/session-state/abc/events.jsonl', [
    { type: 'session.start', data: { sessionId: 'abc' }, timestamp: '2026-11-01T10:00:00Z' },
    { type: 'user.message', data: { content: 'what does main.go do?' }, timestamp: '2026-11-01T10:00:01Z' },
    { type: 'assistant.message', data: { content: 'Let me read it.', toolRequests: [{ toolCallId: 't1', name: 'view', arguments: { path: 'main.go' } }] }, timestamp: '2026-11-01T10:00:02Z' },
    { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, result: { content: 'package main' } }, timestamp: '2026-11-01T10:00:03Z' },
    { type: 'assistant.message', data: { content: 'It is the entry point.' }, timestamp: '2026-11-01T10:00:04Z' },
  ]);
  assert.equal(detectAgent(f), 'copilot');
  const s = PARSERS.copilot.parse(f);
  assert.equal(kinds(s), 'user,assistant,tool,assistant');
  assert.equal(tools(s)[0].output, 'package main');
});

test('Amp thread JSON', () => {
  const f = put('amp/threads/T-1.json', {
    id: 'T-1', title: 'Fix lint',
    messages: [
      { role: 'user', messageId: 0, content: [{ type: 'text', text: 'fix lint errors' }], meta: { sentAt: 1730000000000 } },
      { role: 'assistant', messageId: 1, content: [{ type: 'text', text: 'Running eslint.' }, { type: 'tool_use', id: 'x1', name: 'Bash', input: { cmd: 'npx eslint .' } }], usage: { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 900 } },
      { role: 'user', messageId: 2, content: [{ type: 'tool_result', toolUseID: 'x1', run: { status: 'done', result: { output: '0 problems' } } }] },
    ],
  });
  assert.equal(detectAgent(f), 'amp');
  const s = PARSERS.amp.parse(f);
  assert.equal(s.title, 'Fix lint');
  assert.equal(tools(s)[0].output, '0 problems');
  assert.deepEqual(s.models, ['claude-opus-5-5']);
});

test('Aider chat history markdown', () => {
  const f = put('proj/.aider.chat.history.md', [
    '# aider chat started at 2026-11-01 10:00:00',
    '',
    '> Aider v0.90.0',
    '',
    '#### make greet() say hello',
    '',
    'Here is the change:',
    '',
    'greet.py',
    '```python',
    '<<<<<<< SEARCH',
    'def greet(): print("hi")',
    '=======',
    'def greet(): print("hello")',
    '>>>>>>> REPLACE',
    '```',
    '',
    '> Applied edit to greet.py',
    '',
  ].join('\n'));
  assert.equal(detectAgent(f), 'aider');
  const s = PARSERS.aider.parse(f);
  const edit = tools(s).find((t) => t.name === 'edit');
  assert.equal(edit.file, 'greet.py');
  assert.equal(edit.output, 'Applied edit to greet.py');
  assert.equal(s.events.find((e) => e.kind === 'user').text, 'make greet() say hello');
});

test('generic OpenAI-style chat export', () => {
  const f = put('random/chat-export.json', {
    title: 'Some chat',
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 18}' },
      { role: 'assistant', content: 'It is 18°C.', model: 'gpt-5' },
    ],
  });
  assert.equal(detectAgent(f), 'generic');
  const s = PARSERS.generic.parse(f);
  assert.equal(kinds(s), 'user,tool,assistant');
  assert.equal(tools(s)[0].summary, 'Paris');
  assert.equal(tools(s)[0].output, '{"temp": 18}');
  assert.equal(s.timesSynthetic, true);
});

test('generic: unknown JSONL with envelope records', () => {
  const f = put('random/log.jsonl', [
    { ts: 1730000000, kind: 'x', message: { role: 'human', text: 'hi there' } },
    { ts: 1730000005, kind: 'x', message: { role: 'ai', text: 'hello!' } },
  ]);
  const s = PARSERS.generic.parse(f);
  assert.equal(kinds(s), 'user,assistant');
  assert.equal(s.events[1].t, 1730000005000);
});

test('rejects files with no conversation', () => {
  const f = put('random/config.json', { theme: 'dark', fontSize: 14 });
  assert.equal(detectAgent(f), null);
});

test('OpenCode SQLite database (node:sqlite)', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return t.skip('node:sqlite not available on this Node version');
  }
  const db = path.join(root, 'opencode-db', 'opencode.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
          CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
          CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  d.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('ses_a', 'DB session', '/repo', null, 1730000000000, 1730000005000);
  d.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_a', 1730000000000, JSON.stringify({ role: 'user' }));
  d.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'ses_a', 1730000002000, JSON.stringify({ role: 'assistant', modelID: 'kimi-k3', tokens: { input: 5, output: 7 } }));
  d.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses_a', 1730000000000, JSON.stringify({ type: 'text', text: 'hello db' }));
  d.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p2', 'm2', 'ses_a', 1730000002000, JSON.stringify({ type: 'text', text: 'hi from sqlite' }));
  d.close();
  const s = PARSERS.opencode.parse(`${db}#ses_a`);
  assert.equal(s.title, 'DB session');
  assert.equal(kinds(s), 'user,assistant');
  assert.deepEqual(s.models, ['kimi-k3']);
  assert.equal(s.events[1].t, 1730000002000);
});

test('Codex: harness tags in user messages are stripped', async () => {
  const codex = await import('../src/parsers/codex.js');
  const ts = '2026-01-01T00:00:00Z';
  const f = put('codex-tags/rollout-x.jsonl', [
    { timestamp: ts, type: 'session_meta', payload: { id: 'z' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>private context</system-reminder>' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>more</system-reminder>\nfix the bug' }] } },
  ]);
  const s = codex.parse(f);
  assert.deepEqual(s.events.map((e) => e.text), ['fix the bug']);
  assert.equal(s.title, 'fix the bug');
});
