import path from 'node:path';
import { readJsonl, toText, stripHarnessTags, truncate, lineDelta, trackRequest } from '../util.js';

const MAX_OUTPUT = 4000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Does this file look like a Claude Code session log? */
export function detect(records) {
  return records.some((r) => (r.type === 'assistant' || r.type === 'user') && r.message && !r.message.parts && r.sessionId && ('parentUuid' in r || 'uuid' in r));
}

/**
 * Parse a Claude Code session (~/.claude/projects/<project>/<session>.jsonl)
 * into the normalized replay shape shared by every parser.
 */
export function parse(file, { includeSidechains = false } = {}) {
  const records = readJsonl(file);
  const session = {
    agent: 'Claude Code',
    id: path.basename(file, '.jsonl'),
    title: null,
    cwd: null,
    branch: null,
    models: new Set(),
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: {},
  };

  const toolById = new Map();
  const seenMessageIds = new Set();

  for (const r of records) {
    if (r.type === 'ai-title' && r.aiTitle) session.title = r.aiTitle;
    if (r.type === 'summary' && r.summary && !session.title) session.title = r.summary;
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isSidechain && !includeSidechains) continue;
    if (!session.cwd && r.cwd) session.cwd = r.cwd;
    if (!session.branch && r.gitBranch) session.branch = r.gitBranch;

    const ts = Date.parse(r.timestamp);
    const msg = r.message || {};
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];

    if (r.type === 'assistant') {
      const model = msg.model && msg.model !== '<synthetic>' ? msg.model : null;
      if (model) session.models.add(model);
      // Claude Code writes one line per content block but repeats the usage of the
      // whole API message on each — count it once per message id.
      if (msg.usage && msg.id && !seenMessageIds.has(msg.id)) {
        seenMessageIds.add(msg.id);
        addUsage(session, model, msg.usage);
      }
    }

    for (const b of blocks) {
      if (r.type === 'user' && b.type === 'tool_result') {
        const ev = toolById.get(b.tool_use_id);
        if (!ev) continue;
        ev.output = truncate(stripHarnessTags(toText(b.content)), MAX_OUTPUT);
        ev.isError = !!b.is_error;
        ev.endT = ts;
        continue;
      }
      if (r.type === 'user' && b.type === 'text') {
        if (r.isMeta) continue;
        const text = stripHarnessTags(b.text || '');
        if (!text || /^<(command-|local-command|bash-|user-prompt-submit-hook)/.test(text)) continue;
        if (text.startsWith('Caveat: The messages below')) continue;
        session.events.push({ kind: 'user', t: ts, text });
        continue;
      }
      if (r.type !== 'assistant') continue;
      if (b.type === 'text' && b.text?.trim()) {
        session.events.push({ kind: 'assistant', t: ts, text: b.text.trim() });
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        session.events.push({ kind: 'thinking', t: ts, text: b.thinking.trim() });
      } else if (b.type === 'tool_use') {
        const ev = toolEvent(b, ts);
        toolById.set(b.id, ev);
        session.events.push(ev);
      }
    }
  }

  session.models = [...session.models];
  return session;
}

function addUsage(session, model, u) {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const add = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: (u.cache_creation_input_tokens || 0) - write1h,
    cacheWrite1h: write1h,
  };
  const key = model || 'unknown';
  const per = (session.usageByModel[key] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  for (const k of Object.keys(add)) {
    session.usage[k] += add[k];
    per[k] += add[k];
  }
  trackRequest(session, add);
}

function toolEvent(b, ts) {
  const input = b.input || {};
  // mcp__Roblox_Studio__execute_luau → "Roblox Studio · execute_luau"
  const name = b.name.replace(/^mcp__(.+?)__(.+)$/, (_, server, tool) => `${server.replace(/_/g, ' ')} · ${tool}`);
  const ev = { kind: 'tool', t: ts, name, summary: summarize(b.name, input), input: null, output: '', isError: false };

  if (EDIT_TOOLS.has(b.name)) {
    const file = input.file_path || input.notebook_path;
    ev.file = file;
    if (b.name === 'Edit') {
      ev.diff = [{ old: input.old_string || '', new: input.new_string || '' }];
    } else if (b.name === 'MultiEdit') {
      ev.diff = (input.edits || []).map((e) => ({ old: e.old_string || '', new: e.new_string || '' }));
    } else if (b.name === 'Write') {
      ev.diff = [{ old: '', new: input.content || '' }];
      ev.created = true;
    } else {
      ev.diff = [{ old: '', new: input.new_source || '' }];
    }
    ev.lines = ev.diff.reduce(
      (acc, d) => {
        const x = lineDelta(d.old, d.new);
        return { added: acc.added + x.added, removed: acc.removed + x.removed };
      },
      { added: 0, removed: 0 },
    );
    ev.diff = ev.diff.map((d) => ({ old: truncate(d.old, MAX_OUTPUT), new: truncate(d.new, MAX_OUTPUT) }));
  } else {
    ev.input = truncate(JSON.stringify(input, null, 2), MAX_OUTPUT);
  }
  return ev;
}

const PREFERRED_KEYS = ['description', 'command', 'query', 'file_path', 'path', 'url', 'name', 'title', 'prompt', 'code', 'text'];
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$|^[A-Za-z0-9_-]{20,}$/i;

/** Best human-readable string from an unknown tool's input (MCP tools etc.). */
function genericSummary(i) {
  for (const k of PREFERRED_KEYS) {
    if (typeof i[k] === 'string' && i[k].trim()) return i[k].trim().split('\n')[0];
  }
  const strings = Object.values(i).filter((v) => typeof v === 'string' && v.trim() && !ID_LIKE.test(v.trim()));
  return strings.length ? strings[0].trim().split('\n')[0] : '';
}

function summarize(name, i) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return i.description || i.command;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return i.file_path;
    case 'NotebookEdit':
      return i.notebook_path;
    case 'Glob':
      return i.pattern;
    case 'Grep':
      return `${i.pattern}${i.path ? ' in ' + i.path : ''}`;
    case 'WebSearch':
      return i.query;
    case 'WebFetch':
      return i.url;
    case 'Task':
    case 'Agent':
      return i.description || i.prompt;
    case 'Skill':
      return i.skill;
    default:
      return genericSummary(i);
  }
}
