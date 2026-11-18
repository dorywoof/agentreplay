import path from 'node:path';
import { readJsonl, toText, truncate, parsePatch } from '../util.js';

const MAX_OUTPUT = 4000;

/** Does this file look like a Codex rollout log? */
export function detect(records) {
  return records.some((r) => r.type === 'session_meta' || (r.type === 'response_item' && r.payload));
}

/**
 * Parse a Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * into the normalized replay shape shared by every parser.
 */
export function parse(file) {
  const records = readJsonl(file);
  const session = {
    agent: 'Codex',
    id: path.basename(file, '.jsonl').replace(/^rollout-/, ''),
    title: null,
    cwd: null,
    branch: null,
    models: new Set(),
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: {},
  };
  const toolById = new Map();
  let lastTotals = null;
  let currentModel = null;

  for (const r of records) {
    const p = r.payload || {};
    const ts = Date.parse(r.timestamp);

    if (r.type === 'session_meta') {
      session.cwd ||= p.cwd;
      session.branch ||= p.git?.branch || null;
      if (p.id) session.id = p.id;
    }
    if (r.type === 'turn_context') {
      session.cwd ||= p.cwd;
      if (p.model) currentModel = p.model;
    }
    if (r.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) {
      currentModel = p.thread_settings.model;
    }
    if (currentModel) session.models.add(currentModel);

    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      lastTotals = p.info.total_token_usage; // cumulative — keep the last one
      continue;
    }
    if (r.type !== 'response_item') continue;

    switch (p.type) {
      case 'message': {
        if (p.role === 'developer' || p.role === 'system') break;
        const text = toText(p.content).trim();
        if (!text) break;
        if (p.role === 'user') {
          // Codex injects environment / instruction blocks as user messages.
          if (/^<(environment_context|user_instructions|permissions|INSTRUCTIONS)/.test(text)) break;
          if (text.startsWith('# AGENTS.md instructions')) break;
          session.events.push({ kind: 'user', t: ts, text });
          session.title ||= text.split('\n')[0].slice(0, 80);
        } else {
          session.events.push({ kind: 'assistant', t: ts, text });
        }
        break;
      }
      case 'reasoning': {
        const text = (p.summary || []).map(toText).join('\n').trim();
        if (text) session.events.push({ kind: 'thinking', t: ts, text });
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const raw = p.type === 'function_call' ? p.arguments : p.type === 'custom_tool_call' ? p.input : JSON.stringify(p.action);
        const ev = toolEvent(p.name || 'shell', raw, ts);
        if (p.call_id) toolById.set(p.call_id, ev);
        session.events.push(ev);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const ev = toolById.get(p.call_id);
        if (!ev) break;
        const { text, exitCode } = parseOutput(p.output);
        ev.output = truncate(text, MAX_OUTPUT);
        ev.isError = exitCode != null && exitCode !== 0;
        ev.endT = ts;
        break;
      }
    }
  }

  if (lastTotals) {
    const cached = lastTotals.cached_input_tokens || 0;
    session.usage.input = (lastTotals.input_tokens || 0) - cached; // OpenAI counts cached inside input
    session.usage.cacheRead = cached;
    session.usage.cacheWrite = lastTotals.cache_write_input_tokens || 0;
    session.usage.output = lastTotals.output_tokens || 0;
    const model = [...session.models].pop() || 'unknown';
    session.usageByModel[model] = { ...session.usage };
  }
  session.models = [...session.models];
  return session;
}

function parseOutput(output) {
  let text = typeof output === 'string' ? output : toText(output);
  let exitCode = null;
  // Outputs are often JSON envelopes like {"output": "...", "metadata": {"exit_code": 0}}
  const pieces = [];
  for (const chunk of text.split('\n')) {
    const trimmed = chunk.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const o = JSON.parse(trimmed);
        if ('exit_code' in o) exitCode = o.exit_code;
        if (o.metadata && 'exit_code' in o.metadata) exitCode = o.metadata.exit_code;
        if (typeof o.output === 'string') {
          pieces.push(o.output);
          continue;
        }
      } catch {
        /* not JSON */
      }
    }
    pieces.push(chunk);
  }
  text = pieces.join('\n').trim();
  return { text, exitCode };
}

function toolEvent(name, raw, ts) {
  let args = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      args = raw;
    }
  }
  const ev = { kind: 'tool', t: ts, name, summary: '', input: null, output: '', isError: false };

  const patch = typeof args === 'string' && args.includes('*** Begin Patch') ? args : args?.input?.includes?.('*** Begin Patch') ? args.input : null;
  if (patch) {
    Object.assign(ev, fromPatch(patch));
    ev.name = 'apply_patch';
    return ev;
  }

  if (args && typeof args === 'object') {
    const cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command || args.cmd;
    ev.summary = cmd || Object.values(args).find((v) => typeof v === 'string') || '';
    ev.input = truncate(JSON.stringify(args, null, 2), MAX_OUTPUT);
  } else {
    const s = String(args ?? '');
    const cmd = s.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/);
    ev.summary = cmd ? cmd[1].replace(/\\"/g, '"') : s.split('\n')[0];
    ev.input = truncate(s, MAX_OUTPUT);
  }
  ev.summary = ev.summary.slice(0, 200);
  return ev;
}

function fromPatch(patch) {
  return parsePatch(patch, MAX_OUTPUT);
}
