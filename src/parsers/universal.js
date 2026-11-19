/**
 * The universal parser. Most coding agents store a conversation as a list of
 * messages in one of a handful of dialects: Anthropic content blocks, OpenAI
 * chat messages with tool_calls, Gemini parts, or something close to one of
 * them. This module recognises all of those field by field, so new agents (and
 * any exported chat log) replay without a dedicated parser.
 */
import path from 'node:path';
import fs from 'node:fs';
import { readJsonAny, toText, stripHarnessTags, truncate, lineDelta, toMs, newSession, addUsage, parsePatch, parseSearchReplace, setOutput } from '../util.js';

const MAX = 4000;
const LIST_KEYS = ['messages', 'history', 'conversation', 'chat_messages', 'chatMessages', 'turns', 'items', 'events', 'entries', 'log', 'data'];

// ---------------------------------------------------------------------------
// Finding the messages
// ---------------------------------------------------------------------------

/** Pull a flat, ordered list of message-like objects out of any JSON shape. */
export function extractMessages(input) {
  if (Array.isArray(input)) {
    // JSONL lines, or a top-level array of messages
    const out = [];
    for (const item of input) {
      if (looksLikeMessage(item)) out.push(item);
      else if (item && typeof item === 'object') {
        const inner = unwrap(item);
        if (inner) out.push(inner);
        else {
          const nested = findList(item);
          if (nested) out.push(...extractMessages(nested));
        }
      }
    }
    return out;
  }
  if (input && typeof input === 'object') {
    const list = findList(input);
    if (list) return extractMessages(list);
    if (looksLikeMessage(input)) return [input];
  }
  return [];
}

function findList(obj) {
  for (const k of LIST_KEYS) if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
  for (const k of LIST_KEYS) if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
    const l = findList(obj[k]);
    if (l) return l;
  }
  return null;
}

/** JSONL envelopes: {type, timestamp, message:{…}} / {payload:{…}} / {data:{…}} */
function unwrap(rec) {
  for (const k of ['message', 'payload', 'data', 'msg', 'item']) {
    const inner = rec[k];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && looksLikeMessage({ ...inner, type: inner.type ?? rec.type })) {
      return {
        ...inner,
        role: inner.role ?? roleFromType(rec.type),
        type: inner.type ?? rec.type,
        timestamp: inner.timestamp ?? rec.timestamp ?? rec.ts ?? rec.created_at ?? rec.createdAt,
        model: inner.model ?? rec.model,
        usage: inner.usage ?? rec.usage ?? rec.usageMetadata ?? rec.tokens,
        id: inner.id ?? rec.uuid ?? rec.id,
      };
    }
  }
  return null;
}

function looksLikeMessage(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const hasRole = typeof o.role === 'string' || typeof o.type === 'string' || typeof o.author === 'string' || typeof o.sender === 'string' || typeof o.from === 'string';
  const hasBody =
    'content' in o || 'parts' in o || 'text' in o || 'tool_calls' in o || 'toolCalls' in o || 'toolRequests' in o ||
    'functionCall' in o || 'function_call' in o || 'output' in o || 'result' in o || 'thoughts' in o;
  return hasRole && hasBody;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function roleFromType(t) {
  if (typeof t !== 'string') return undefined;
  const s = t.toLowerCase();
  if (/^(user|human)\b|user[._-]?(message|prompt|input)/.test(s)) return 'user';
  if (/^(assistant|ai|model|gemini|bot|agent)\b|assistant[._-]?message|agent[._-]?message/.test(s)) return 'assistant';
  if (/tool[._-]?(result|output|response|execution[._-]?complete)|function[._-]?(result|response|call[._-]?output)/.test(s)) return 'tool';
  if (/^(system|developer|info|meta|summary)/.test(s)) return 'system';
  return undefined;
}

function roleOf(m) {
  const raw = (m.role || m.author?.role || m.author || m.sender || m.from || '').toString().toLowerCase();
  if (['user', 'human', 'you', 'me'].includes(raw)) return 'user';
  if (['assistant', 'ai', 'model', 'gemini', 'bot', 'agent', 'claude', 'gpt', 'copilot'].includes(raw)) return 'assistant';
  if (['tool', 'function', 'tool_result', 'ipython'].includes(raw)) return 'tool';
  if (['system', 'developer'].includes(raw)) return 'system';
  return roleFromType(m.type) || (raw ? 'assistant' : 'system');
}

// ---------------------------------------------------------------------------
// Building the replay
// ---------------------------------------------------------------------------

/**
 * @param {object[]} messages  ordered message-like objects
 * @param {object}   opts      { agent, id, title, cwd, model, baseTime, file }
 */
export function buildSession(messages, opts = {}) {
  const s = newSession(opts.agent || 'AI agent', opts.id);
  s.title = opts.title || null;
  s.cwd = opts.cwd || null;
  const pending = new Map(); // tool call id → event
  const order = []; // pending tool events without a result, oldest first

  const attach = (id, name, output, isError, t) => {
    let ev = id != null ? pending.get(String(id)) : null;
    if (!ev && name) ev = [...order].reverse().find((e) => !e.done && e.rawName === name);
    if (!ev) ev = order.find((e) => !e.done);
    if (!ev) return false;
    setOutput(ev, stripHarnessTags(output || ''), MAX);
    ev.isError = !!isError;
    ev.done = true;
    if (t) ev.endT = t;
    return true;
  };

  const push = (ev) => s.events.push(ev);

  for (const m of messages) {
    const role = roleOf(m);
    if (role === 'system') continue;
    const t = toMs(m.timestamp ?? m.time?.created ?? m.created_at ?? m.createdAt ?? m.created ?? m.ts ?? m.date ?? m.meta?.sentAt ?? m.sentAt);
    const model = modelOf(m) || opts.model;
    if (model) s.models.add(model);
    const u = readUsage(m.usage ?? m.tokens ?? m.usageMetadata ?? m.usage_metadata ?? m.metrics);
    if (u) addUsage(s, model, u, t);
    if (typeof m.cost === 'number' && m.cost > 0) s.reportedCost = (s.reportedCost || 0) + m.cost;

    // Tool result messages (OpenAI role:"tool", Gemini functionResponse, Copilot tool.execution_complete …)
    if (role === 'tool') {
      const id = m.tool_call_id ?? m.toolCallId ?? m.call_id ?? m.tool_use_id ?? m.id;
      const out = m.content ?? m.output ?? m.result ?? m.response ?? m.parts;
      const parts = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : null;
      if (parts && parts.some((p) => p && (p.functionResponse || p.type === 'tool_result'))) {
        for (const p of parts) handleBlock(p, 'user', t);
      } else {
        attach(id, m.name ?? m.toolName, resultText(out), m.is_error || m.success === false || m.status === 'error', t);
      }
      continue;
    }

    // Reasoning first, then what the model said, then the tools it called
    for (const th of m.thoughts || []) {
      const text = typeof th === 'string' ? th : [th.subject, th.description].filter(Boolean).join(': ');
      if (text) push({ kind: 'thinking', t, text });
    }
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) push({ kind: 'thinking', t, text: m.reasoning_content.trim() });

    // Plain text / content blocks / parts
    const blocks = blocksOf(m);
    for (const b of blocks) handleBlock(b, role, t);

    // Side-channel tool calls
    for (const tc of m.tool_calls || m.toolCalls || m.toolRequests || m.function_calls || []) toolCall(tc, t);
    if (m.function_call) toolCall({ function: m.function_call }, t);
  }

  function handleBlock(b, role, t) {
    if (b == null) return;
    if (typeof b === 'string') return text(b, role, t);
    const type = b.type;
    if (b.thought === true && typeof b.text === 'string') return push({ kind: 'thinking', t, text: b.text.trim() });
    if (type === 'thinking' || type === 'reasoning' || type === 'redacted_thinking') {
      const tx = (b.thinking ?? b.text ?? toText(b.summary) ?? '').trim();
      if (tx) push({ kind: 'thinking', t, text: tx });
      return;
    }
    if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call' || type === 'function_call' || b.functionCall) {
      return toolCall(b.functionCall ? { ...b.functionCall, id: b.functionCall.id ?? b.id } : b, t);
    }
    if (type === 'tool' && (b.tool || b.state)) return opencodeTool(b, t);
    if (type === 'tool_result' || type === 'tool-result' || type === 'function_call_output' || b.functionResponse) {
      const fr = b.functionResponse;
      const id = b.tool_use_id ?? b.toolUseID ?? b.toolUseId ?? b.tool_call_id ?? b.call_id ?? fr?.id;
      const out = fr ? fr.response : b.content ?? b.output ?? b.run?.result ?? b.result;
      const err = b.is_error || b.isError || b.run?.status === 'error' || b.status === 'error';
      return void attach(id, fr?.name ?? b.name, resultText(out), err, t);
    }
    if (type === 'image' || type === 'image_url' || b.inlineData) return text('[image]', role, t);
    if (type === 'step-start' || type === 'step-finish' || type === 'snapshot' || type === 'patch' || type === 'compaction') return;
    if (b.synthetic) return;
    const tx = b.text ?? b.content ?? b.value;
    if (typeof tx === 'string') return text(tx, role, t);
    if (tx && typeof tx === 'object') return handleBlock(tx, role, t);
  }

  function text(raw, role, t) {
    let tx = stripHarnessTags(String(raw))
      .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '')
      .replace(/<\/?task>/g, '')
      .trim();
    if (!tx) return;
    if (role === 'user') {
      // Cline/Roo feed tool results back as user text: "[read_file for 'x'] Result:\n…"
      const r = tx.match(/^\[([\w-]+)(?: for [^\]]*)?\] Result:\s*([\s\S]*)$/);
      if (r && attach(null, r[1], r[2], /^(Error|The tool execution failed)/i.test(r[2].trim()), t)) return;
      if (/^(<command-|<local-command|Caveat: The messages below)/.test(tx)) return;
      // Harness-injected context blocks (<environment_context>…</environment_context> etc.)
      if (/^<([\w-]+)[^>]*>[\s\S]*<\/\1>$/.test(tx)) return;
      return push({ kind: 'user', t, text: tx });
    }
    // Assistants in XML-tool dialects (Cline, Roo, Kilo, older Aider-likes)
    tx = tx.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_, th) => {
      if (th.trim()) push({ kind: 'thinking', t, text: th.trim() });
      return '';
    });
    const xmlTools = [];
    tx = tx.replace(XML_TOOL_RE, (_, name, inner) => {
      xmlTools.push({ name, input: xmlParams(inner) });
      return '';
    });
    tx = tx.trim();
    if (tx) push({ kind: 'assistant', t, text: tx });
    for (const x of xmlTools) {
      if (x.name === 'attempt_completion' && x.input.result) push({ kind: 'assistant', t, text: x.input.result });
      else toolCall({ name: x.name, input: x.input }, t);
    }
  }

  function toolCall(tc, t) {
    const fn = tc.function || tc;
    const name = fn.name || tc.name || tc.toolName || tc.tool || 'tool';
    let args = fn.arguments ?? fn.args ?? tc.input ?? tc.args ?? tc.arguments ?? tc.parameters ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep raw string (e.g. a patch) */
      }
    }
    const ev = toolEvent(name, args, t);
    const id = tc.id ?? tc.toolCallId ?? tc.tool_call_id ?? tc.call_id ?? tc.callID ?? fn.id;
    push(ev);
    if (id != null) pending.set(String(id), ev);
    order.push(ev);
    // Gemini CLI stores the result next to the call
    const inline = tc.result ?? tc.output ?? tc.resultDisplay ?? tc.response;
    if (inline !== undefined) {
      setOutput(ev, resultText(inline), MAX);
      ev.isError = tc.status === 'error' || tc.status === 'failed' || tc.success === false;
      ev.done = true;
    }
  }

  function opencodeTool(p, t) {
    const st = p.state || {};
    const ev = toolEvent(p.tool || 'tool', st.input || {}, toMs(st.time?.start) || t);
    if (st.status === 'completed' || st.status === 'error' || st.output != null || st.error != null) {
      setOutput(ev, resultText(st.output ?? st.error ?? ''), MAX);
      ev.isError = st.status === 'error';
      ev.done = true;
      ev.endT = toMs(st.time?.end) || undefined;
    }
    if (st.title && !ev.summary) ev.summary = st.title;
    push(ev);
    if (p.callID) pending.set(String(p.callID), ev);
  }

  // Fill in missing timestamps so the player still has an order to follow.
  const known = s.events.filter((e) => Number.isFinite(e.t));
  if (known.length < s.events.length) {
    if (!known.length) {
      s.timesSynthetic = true;
      const base = opts.baseTime ?? (opts.file ? safeMtime(opts.file) : Date.now());
      const step = 2500;
      s.events.forEach((e, i) => (e.t = base - (s.events.length - i) * step));
    } else {
      let last = known[0].t;
      for (const e of s.events) {
        if (Number.isFinite(e.t)) last = e.t;
        else e.t = last;
      }
    }
  }
  for (const e of s.events) {
    delete e.done;
    delete e.rawName;
  }
  if (!s.title) {
    const first = s.events.find((e) => e.kind === 'user');
    if (first) s.title = first.text.split('\n')[0].slice(0, 80);
  }
  s.models = [...s.models];
  return s;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function blocksOf(m) {
  if (Array.isArray(m.content)) return m.content;
  if (Array.isArray(m.parts)) return m.parts;
  if (typeof m.content === 'string') return [m.content];
  if (m.content && typeof m.content === 'object') return [m.content];
  if (typeof m.text === 'string') return [m.text];
  if (typeof m.message === 'string') return [m.message];
  return [];
}

function modelOf(m) {
  const v = m.model ?? m.modelID ?? m.model_id ?? m.modelId ?? m.usage?.model ?? m.metadata?.model;
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.modelID || v.id || v.name || null;
}

const num = (...vals) => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
};

/** Token usage in any of the common spellings. */
export function readUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cacheRead = num(u.cache_read_input_tokens, u.cacheReadInputTokens, u.cache?.read, u.cacheRead, u.cacheReads, u.cached, u.cachedContentTokenCount, u.cached_input_tokens, u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens, u.cacheCreationInputTokens, u.cache?.write, u.cacheWrite, u.cacheWrites);
  let input = num(u.input_tokens, u.inputTokens, u.input, u.prompt_tokens, u.promptTokens, u.promptTokenCount, u.tokensIn, u.prompt);
  const output = num(u.output_tokens, u.outputTokens, u.output, u.completion_tokens, u.completionTokens, u.candidatesTokenCount, u.tokensOut, u.completion) + num(u.reasoning, u.thoughts, u.thoughtsTokenCount);
  // OpenAI and Gemini count cached tokens inside the prompt total.
  const cachedInsidePrompt = u.prompt_tokens != null || u.promptTokenCount != null || u.cached != null;
  if (cachedInsidePrompt && cacheRead && input >= cacheRead) input -= cacheRead;
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return { input, output, cacheRead, cacheWrite, cacheWrite1h: 0 };
}

function resultText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(resultText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    if (v.functionResponse) return resultText(v.functionResponse.response);
    for (const k of ['output', 'text', 'content', 'result', 'stdout', 'error', 'message']) {
      if (v[k] != null && (typeof v[k] === 'string' || typeof v[k] === 'object')) {
        const r = resultText(v[k]);
        if (r) return r;
      }
    }
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

const XML_TOOL_RE = /<(read_file|write_to_file|replace_in_file|apply_diff|insert_content|search_and_replace|execute_command|search_files|list_files|list_code_definition_names|browser_action|use_mcp_tool|access_mcp_resource|ask_followup_question|attempt_completion|new_task|switch_mode|codebase_search|fetch_instructions|plan_mode_respond|edit_file|new_rule|web_fetch)>([\s\S]*?)<\/\1>/g;

function xmlParams(inner) {
  const out = {};
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(inner))) out[m[1]] = m[2].replace(/^\n/, '').replace(/\n$/, '');
  if (!Object.keys(out).length && inner.trim()) out.input = inner.trim();
  return out;
}

const EDIT_NAME = /edit|write|replace|patch|create_file|str_replace|insert|apply_diff|search_and_replace|multiedit/i;
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'file', 'filename', 'absolute_path', 'notebook_path'];

/** Normalized tool event, with a diff when the call edits a file. */
export function toolEvent(name, args, t) {
  const ev = { kind: 'tool', t, name: prettyName(name), rawName: name, summary: '', input: null, output: '', isError: false };
  const a = args && typeof args === 'object' ? args : {};
  const raw = typeof args === 'string' ? args : null;

  const patchText = raw?.includes('*** Begin Patch') ? raw : typeof a.input === 'string' && a.input.includes('*** Begin Patch') ? a.input : typeof a.patch === 'string' && a.patch.includes('*** Begin Patch') ? a.patch : null;
  if (patchText) return Object.assign(ev, parsePatch(patchText, MAX));

  const file = PATH_KEYS.map((k) => a[k]).find((v) => typeof v === 'string');
  if (EDIT_NAME.test(name) && file) {
    let diff = null;
    const oldS = a.old_string ?? a.oldString ?? a.old_str ?? a.search ?? a.old_text ?? a.oldText;
    const newS = a.new_string ?? a.newString ?? a.new_str ?? a.replace ?? a.new_text ?? a.newText;
    if (typeof oldS === 'string' || typeof newS === 'string') diff = [{ old: oldS || '', new: newS || '' }];
    else if (Array.isArray(a.edits)) diff = a.edits.map((e) => ({ old: e.old_string ?? e.oldString ?? e.oldText ?? '', new: e.new_string ?? e.newString ?? e.newText ?? '' }));
    else if (typeof a.diff === 'string' && parseSearchReplace(a.diff).length) diff = parseSearchReplace(a.diff);
    else {
      const content = a.content ?? a.file_text ?? a.contents ?? a.new_content ?? a.code_edit ?? a.text;
      if (typeof content === 'string') {
        diff = [{ old: '', new: content }];
        ev.created = /write|create/i.test(name);
      }
    }
    if (diff) {
      ev.file = file;
      ev.summary = file;
      ev.lines = diff.reduce((acc, d) => {
        const x = lineDelta(d.old, d.new);
        return { added: acc.added + x.added, removed: acc.removed + x.removed };
      }, { added: 0, removed: 0 });
      ev.diff = diff.map((d) => ({ old: truncate(d.old, MAX), new: truncate(d.new, MAX) }));
      return ev;
    }
  }

  ev.summary = summaryOf(a, raw);
  ev.input = truncate(raw ?? JSON.stringify(a, null, 2), MAX);
  return ev;
}

const SUMMARY_KEYS = ['description', 'command', 'cmd', 'query', 'pattern', 'regex', 'file_path', 'filePath', 'path', 'target_file', 'url', 'name', 'title', 'prompt', 'question', 'code', 'text'];
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i;

function summaryOf(a, raw) {
  if (raw) return raw.split('\n')[0].slice(0, 200);
  for (const k of SUMMARY_KEYS) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim().split('\n')[0].slice(0, 200);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ').slice(0, 200);
  }
  const s = Object.values(a).find((v) => typeof v === 'string' && v.trim() && !ID_LIKE.test(v.trim()));
  return s ? s.trim().split('\n')[0].slice(0, 200) : '';
}

/** mcp__server__tool → "server · tool" */
export function prettyName(name) {
  return String(name).replace(/^mcp__(.+?)__(.+)$/, (_, s, t) => `${s.replace(/_/g, ' ')} · ${t}`);
}

function safeMtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Does this file contain something we can replay? */
export function detect(file) {
  try {
    const { doc, lines } = readJsonAny(file);
    return extractMessages(doc ?? lines).length > 0;
  } catch {
    return false;
  }
}

/** Replay any JSON / JSONL chat log. */
export function parse(file, opts = {}) {
  const { doc, lines } = readJsonAny(file);
  const root = doc ?? lines;
  const meta = doc && !Array.isArray(doc) ? doc : (lines || []).find((l) => l && (l.sessionId || l.session_id || l.title || l.cwd)) || {};
  return buildSession(extractMessages(root), {
    agent: opts.agent || 'AI agent',
    id: meta.sessionId || meta.session_id || meta.id || path.basename(file).replace(/\.(jsonl?|json)$/, ''),
    title: meta.title || meta.summary || meta.name || null,
    cwd: meta.cwd || meta.directory || meta.projectPath || null,
    file,
  });
}
