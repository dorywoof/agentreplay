/**
 * Thin adapters for agents whose logs the universal parser can read once the
 * right files are found and stitched together.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJsonAny, toMs, addUsage, lineDelta, truncate, parseSearchReplace } from '../util.js';
import { buildSession, parse as parseUniversal, extractMessages } from './universal.js';

const home = os.homedir();
const env = process.env;

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

export function walk(dir, depth, match, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, match, out);
    else if (e.isFile() && match(e.name, p)) out.push(p);
  }
  return out;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

/** VS Code-family globalStorage folders on this OS (VS Code, Insiders, VSCodium, Cursor, Windsurf…). */
function globalStorageRoots() {
  const apps = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae', 'Kiro', 'Positron'];
  const base =
    process.platform === 'win32'
      ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return apps.map((a) => path.join(base, a, 'User', 'globalStorage'));
}

const dataHome = () =>
  env.XDG_DATA_HOME || (process.platform === 'win32' ? path.join(home, '.local', 'share') : path.join(home, '.local', 'share'));

// ---------------------------------------------------------------------------
// Gemini CLI  ~/.gemini/tmp/<project>/chats/*.json(l)
// ---------------------------------------------------------------------------
export const gemini = {
  label: 'Gemini CLI',
  find: () => walk(path.join(env.GEMINI_DIR || path.join(home, '.gemini'), 'tmp'), 3, (n, p) => /\.jsonl?$/.test(n) && /[\\/]chats[\\/]/.test(p)),
  match: (f) => /[\\/]\.gemini[\\/]/.test(f),
  parse: (f) => parseUniversal(f, { agent: 'Gemini CLI' }),
};

// ---------------------------------------------------------------------------
// Qwen Code  ~/.qwen/projects/<project>/chats/*.jsonl
// ---------------------------------------------------------------------------
export const qwen = {
  label: 'Qwen Code',
  find: () => walk(path.join(env.QWEN_DATA_DIR || path.join(home, '.qwen'), 'projects'), 3, (n, p) => n.endsWith('.jsonl') && /[\\/]chats[\\/]/.test(p)),
  match: (f) => /[\\/]\.qwen[\\/]/.test(f),
  parse: (f) => parseUniversal(f, { agent: 'Qwen Code' }),
};

// ---------------------------------------------------------------------------
// Amp  ~/.local/share/amp/threads/**/*.json
// ---------------------------------------------------------------------------
export const amp = {
  label: 'Amp',
  find: () => walk(path.join(env.AMP_DATA_DIR || path.join(dataHome(), 'amp'), 'threads'), 3, (n) => n.endsWith('.json')),
  match: (f) => /[\\/]amp[\\/]threads[\\/]/.test(f),
  parse: (f) => parseUniversal(f, { agent: 'Amp' }),
};

// ---------------------------------------------------------------------------
// GitHub Copilot CLI  ~/.copilot/session-state/**/events.jsonl
// ---------------------------------------------------------------------------
export const copilot = {
  label: 'Copilot CLI',
  find: () => walk(path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state'), 2, (n) => n.endsWith('.jsonl')),
  match: (f) => /[\\/]\.copilot[\\/]/.test(f),
  parse: (f) => {
    const s = parseUniversal(f, { agent: 'Copilot CLI' });
    try {
      const ws = fs.readFileSync(path.join(path.dirname(f), 'workspace.yaml'), 'utf8');
      const cwd = ws.match(/^cwd:\s*(.+)$/m);
      if (cwd) s.cwd = cwd[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* optional */
    }
    return s;
  },
};

// ---------------------------------------------------------------------------
// Cline / Roo Code / Kilo Code  <globalStorage>/<extension>/tasks/<id>/api_conversation_history.json
// ---------------------------------------------------------------------------
function clineFamily(label, extIds, extraRoots = []) {
  return {
    label,
    find: () => {
      const roots = [...globalStorageRoots().flatMap((g) => extIds.map((id) => path.join(g, id, 'tasks'))), ...extraRoots];
      return roots.flatMap((r) => walk(r, 1, (n) => n === 'api_conversation_history.json'));
    },
    match: (f) => extIds.some((id) => f.includes(id)) || extraRoots.some((r) => f.startsWith(r)),
    parse: (f) => parseClineTask(f, label),
  };
}

export const cline = clineFamily('Cline', ['saoudrizwan.claude-dev'], [path.join(home, '.cline', 'data', 'tasks')]);
export const roo = clineFamily('Roo Code', ['rooveterinaryinc.roo-cline']);
export const kilo = clineFamily('Kilo Code', ['kilocode.kilo-code']);

export function parseClineTask(file, agent = 'Cline') {
  const dir = path.dirname(file);
  const api = readJson(path.join(dir, 'api_conversation_history.json')) || [];
  const ui = readJson(path.join(dir, 'ui_messages.json')) || [];
  const s = buildSession(extractMessages(api), { agent, id: path.basename(dir), file });

  // ui_messages.json carries the real timestamps and per-request usage.
  const times = ui.map((m) => toMs(m.ts)).filter(Number.isFinite);
  if (times.length && s.events.length) {
    const start = Math.min(...times);
    const end = Math.max(...times);
    const step = s.events.length > 1 ? (end - start) / (s.events.length - 1) : 0;
    s.events.forEach((e, i) => {
      e.t = start + i * step;
      if (e.endT) delete e.endT;
    });
    s.timesSynthetic = false;
  }
  let cost = 0;
  for (const m of ui) {
    if (m.say !== 'api_req_started' || typeof m.text !== 'string') continue;
    try {
      const r = JSON.parse(m.text);
      addUsage(s, null, { input: r.tokensIn, output: r.tokensOut, cacheRead: r.cacheReads, cacheWrite: r.cacheWrites });
      if (typeof r.cost === 'number') cost += r.cost;
    } catch {
      /* not JSON */
    }
  }
  if (cost > 0) s.reportedCost = cost;
  const firstTask = ui.find((m) => m.say === 'task' || m.type === 'say');
  if (firstTask?.text && !s.title) s.title = firstTask.text.split('\n')[0].slice(0, 80);
  const meta = readJson(path.join(dir, 'task_metadata.json'));
  const model = meta?.model_usage?.at?.(-1)?.model_id || meta?.model_usage?.at?.(-1)?.model;
  if (model && !s.models.includes(model)) s.models.push(model);
  return s;
}

// ---------------------------------------------------------------------------
// OpenCode  storage/{session,message,part} JSON, opencode.db (SQLite), or `opencode export`
// ---------------------------------------------------------------------------
const opencodeRoots = () =>
  [env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, 'opencode'), path.join(home, '.local', 'share', 'opencode'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'opencode'), env.APPDATA && path.join(env.APPDATA, 'opencode')].filter(Boolean);

export const opencode = {
  label: 'OpenCode',
  find: () => {
    const out = [];
    for (const r of opencodeRoots()) {
      out.push(...walk(path.join(r, 'storage', 'session'), 2, (n) => n.endsWith('.json')));
      const db = path.join(r, 'opencode.db');
      if (fs.existsSync(db)) out.push(...listOpencodeDb(db));
    }
    return out;
  },
  match: (f) => /[\\/]opencode[\\/]/.test(f) || f.includes('opencode.db#'),
  parse: (f) => (f.includes('.db#') ? parseOpencodeDb(f) : parseOpencodeFile(f)),
};

function parseOpencodeFile(file) {
  const doc = readJson(file);
  // `opencode export <id>` → { info, messages: [{ info, parts }] }
  if (doc?.info && Array.isArray(doc.messages)) {
    const msgs = doc.messages.map((m) => ({ ...(m.info || {}), parts: m.parts || [] }));
    return buildSession(msgs, { agent: 'OpenCode', id: doc.info.id, title: doc.info.title, cwd: doc.info.directory, file });
  }
  // storage/session/<project>/<session>.json
  const storage = path.resolve(path.dirname(file), '..', '..');
  const id = doc?.id || path.basename(file, '.json');
  const msgDir = path.join(storage, 'message', id);
  const msgs = walk(msgDir, 0, (n) => n.endsWith('.json'))
    .map(readJson)
    .filter(Boolean)
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const m of msgs) {
    m.parts = walk(path.join(storage, 'part', m.id), 0, (n) => n.endsWith('.json'))
      .map(readJson)
      .filter(Boolean)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return buildSession(msgs, { agent: 'OpenCode', id, title: doc?.title, cwd: doc?.directory, file });
}

function openSqlite(file) {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null; // Node < 22.5 has no built-in SQLite
  }
}

/** Row → object, merging any JSON-text column (opencode keeps message bodies in a `data` column). */
function rowObject(row) {
  const out = { ...row };
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.startsWith('{')) {
      try {
        Object.assign(out, JSON.parse(v));
      } catch {
        /* plain text */
      }
    } else if (/^time_/.test(k) && typeof v === 'number') {
      out.time ||= {};
      out.time[k.slice(5)] = v;
    }
  }
  return out;
}

function listOpencodeDb(db) {
  const d = openSqlite(db);
  if (!d) return [];
  try {
    const rows = d.prepare('SELECT * FROM session').all();
    return rows.filter((r) => !r.parent_id).map((r) => `${db}#${r.id}`);
  } catch {
    return [];
  } finally {
    d.close();
  }
}

function parseOpencodeDb(ref) {
  const [db, id] = ref.split('#');
  const d = openSqlite(db);
  if (!d) throw new Error('reading opencode.db needs Node 22.5+ (built-in SQLite)');
  try {
    const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const sidCol = cols('message').find((c) => /^session_?id$/i.test(c));
    const midCol = cols('part').find((c) => /^message_?id$/i.test(c));
    const sess = rowObject(d.prepare('SELECT * FROM session WHERE id = ?').get(id) || {});
    const msgs = d.prepare(`SELECT * FROM message WHERE ${sidCol} = ? ORDER BY rowid`).all(id).map(rowObject);
    const partStmt = d.prepare(`SELECT * FROM part WHERE ${midCol} = ? ORDER BY rowid`);
    for (const m of msgs) m.parts = partStmt.all(m.id).map(rowObject);
    return buildSession(msgs, { agent: 'OpenCode', id, title: sess.title, cwd: sess.directory, file: db });
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------
// Aider  .aider.chat.history.md (markdown transcript in each project)
// ---------------------------------------------------------------------------
export const aider = {
  label: 'Aider',
  find: () => [path.join(process.cwd(), '.aider.chat.history.md'), path.join(home, '.aider.chat.history.md')].filter((f) => fs.existsSync(f)),
  match: (f) => f.endsWith('.md'),
  parse: parseAider,
};

export function parseAider(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Use only the most recent chat in the file
  const chats = text.split(/^# aider chat started at /m);
  const last = chats.at(-1);
  const started = toMs(last.split('\n')[0].trim().replace(' ', 'T')) ?? fs.statSync(file).mtimeMs;
  const body = last.split('\n').slice(1).join('\n');

  const msgs = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) msgs.push(cur);
    cur = null;
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('#### ')) {
      if (cur?.role !== 'user') flush();
      cur ||= { role: 'user', text: '' };
      cur.text += line.slice(5) + '\n';
    } else if (line.startsWith('> ')) {
      if (cur?.role !== 'info') flush();
      cur ||= { role: 'info', text: '' };
      cur.text += line.slice(2) + '\n';
    } else {
      if (cur && cur.role !== 'assistant') {
        if (!line.trim()) continue;
        flush();
      }
      cur ||= { role: 'assistant', text: '' };
      cur.text += line + '\n';
    }
  }
  flush();

  const events = [];
  let t = started;
  for (const m of msgs) {
    t += 2500;
    const tx = m.text.trim();
    if (m.role === 'user') events.push({ kind: 'user', t, text: tx });
    else if (m.role === 'info') {
      // aider's own console output ("Applied edit to x.py", test runs …) — attach to the last edit or show as a tool
      const last = [...events].reverse().find((e) => e.kind === 'tool' && !e.output);
      if (last) last.output = truncate(tx, 4000);
      else events.push({ kind: 'tool', t, name: 'aider', summary: tx.split('\n')[0], input: null, output: truncate(tx, 4000), isError: /error|failed/i.test(tx) });
    } else {
      // Pull SEARCH/REPLACE edit blocks out into diff events
      const edits = [];
      const rest = tx.replace(/(^|\n)([^\n`]+)\n```[^\n]*\n([\s\S]*?)```/g, (all, pre, fname, block) => {
        const hunks = parseSearchReplace(block);
        if (!hunks.length) return all;
        edits.push({ file: fname.trim(), hunks });
        return pre;
      }).trim();
      if (rest) events.push({ kind: 'assistant', t, text: rest });
      for (const e of edits) {
        const lines = e.hunks.reduce((a, h) => {
          const x = lineDelta(h.old, h.new);
          return { added: a.added + x.added, removed: a.removed + x.removed };
        }, { added: 0, removed: 0 });
        events.push({ kind: 'tool', t, name: 'edit', file: e.file, summary: e.file, diff: e.hunks, lines, created: e.hunks.every((h) => !h.old), input: null, output: '', isError: false });
      }
    }
  }
  return {
    agent: 'Aider',
    id: path.basename(path.dirname(file)) + '-' + Math.round(started / 1000),
    title: events.find((e) => e.kind === 'user')?.text.split('\n')[0].slice(0, 80) || 'Aider chat',
    cwd: path.dirname(file),
    branch: null,
    models: [],
    events,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: {},
    reportedCost: null,
    timesSynthetic: true,
  };
}

// ---------------------------------------------------------------------------
// Anything else: the universal parser on whatever JSON/JSONL file you pass
// ---------------------------------------------------------------------------
export const generic = {
  label: 'Chat log',
  find: () => [],
  match: () => true,
  parse: (f) => parseUniversal(f, { agent: guessAgentName(f) }),
};

function guessAgentName(f) {
  try {
    const { doc, lines } = readJsonAny(f);
    const sample = JSON.stringify(doc ?? (lines || []).slice(0, 30)).slice(0, 20000).toLowerCase();
    for (const [needle, name] of [['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['copilot', 'Copilot'], ['gemini', 'Gemini'], ['claude', 'Claude'], ['gpt-', 'ChatGPT / OpenAI'], ['deepseek', 'DeepSeek'], ['grok', 'Grok'], ['mistral', 'Mistral'], ['llama', 'Llama']]) {
      if (sample.includes(needle)) return name;
    }
  } catch {
    /* unreadable */
  }
  return 'AI agent';
}
