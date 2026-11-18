import fs from 'node:fs';

/** Read a JSONL file, skipping blank or malformed lines. */
export function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line while the agent is still writing — ignore */
    }
  }
  return out;
}

/** Flatten the many shapes "content" can take into plain text. */
export function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.type === 'image') return '[image]';
    if ('content' in content) return toText(content.content);
    if ('output' in content) return toText(content.output);
  }
  return '';
}

/** Remove harness-injected tags that are noise for a human viewer. */
export function stripHarnessTags(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n… (${text.length - max} more characters)`;
}

/** Rough +/- line count between two strings (good enough for stats). */
export function lineDelta(oldStr = '', newStr = '') {
  const a = oldStr ? oldStr.split('\n') : [];
  const b = newStr ? newStr.split('\n') : [];
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = counts.get(l);
    if (c) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return { added: b.length - common, removed: a.length - common };
}

/** Read a file that may be one JSON document or JSONL. Returns { doc } or { lines }. */
export function readJsonAny(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { doc: JSON.parse(trimmed) };
    } catch {
      /* fall through to JSONL */
    }
  }
  return { lines: readJsonl(file) };
}

/** Accept ISO strings, epoch seconds or epoch milliseconds. */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Empty normalized session — every parser fills one of these. */
export function newSession(agent, id) {
  return {
    agent,
    id: String(id || 'session'),
    title: null,
    cwd: null,
    branch: null,
    models: new Set(),
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    usageByModel: {},
    reportedCost: null,
    timesSynthetic: false,
  };
}

/** Add token usage to the session totals and the per-model breakdown. */
export function addUsage(session, model, u) {
  const key = model || 'unknown';
  const per = (session.usageByModel[key] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) {
    const v = Number(u[k]) || 0;
    session.usage[k] += v;
    per[k] += v;
  }
  trackRequest(session, u);
}

/**
 * One API request: count it and remember the biggest prompt. Agents re-send the
 * whole conversation on every request, so summed tokens grow quadratically —
 * the peak prompt is the honest "how big was this conversation" number.
 */
export function trackRequest(session, u) {
  const ctx = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) + (Number(u.cacheWrite1h) || 0);
  if (!ctx && !u.output) return;
  session.requests = (session.requests || 0) + 1;
  session.peakContext = Math.max(session.peakContext || 0, ctx);
}

/** Codex / OpenAI apply_patch envelope → diff hunks. */
export function parsePatch(patch, maxLen = 4000) {
  const files = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      cur = { file: m[2].trim(), op: m[1], old: [], new: [] };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('***') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.new.push(line.slice(1));
    else if (line.startsWith('-')) cur.old.push(line.slice(1));
  }
  const first = files[0] || { file: '(patch)', old: [], new: [] };
  return {
    file: first.file,
    files: files.map((f) => f.file),
    created: first.op === 'Add',
    summary: files.map((f) => f.file).join(', '),
    diff: files.map((f) => ({ old: truncate(f.old.join('\n'), maxLen), new: truncate(f.new.join('\n'), maxLen), file: f.file })),
    lines: files.reduce((a, f) => ({ added: a.added + f.new.length, removed: a.removed + f.old.length }), { added: 0, removed: 0 }),
  };
}

/** Cline / Roo / Aider style SEARCH/REPLACE blocks → diff hunks. */
export function parseSearchReplace(text) {
  const hunks = [];
  const re = /<{5,}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,}\n([\s\S]*?)\n?>{5,}\s*REPLACE/g;
  let m;
  while ((m = re.exec(text))) hunks.push({ old: m[1].replace(/^:start_line:\d+\n-+\n/, ''), new: m[2] });
  return hunks;
}
