import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, stripHarnessTags } from './util.js';
import * as claudeParser from './parsers/claude.js';
import * as codexParser from './parsers/codex.js';
import * as agents from './parsers/agents.js';
import * as universal from './parsers/universal.js';

const home = os.homedir();

const claude = {
  label: 'Claude Code',
  // projects/<project>/<session>.jsonl — subagent logs nested deeper are skipped
  find: () => agents.walk(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'), 1, (n) => n.endsWith('.jsonl')),
  parse: (f) => claudeParser.parse(f),
};
const codex = {
  label: 'Codex',
  find: () => agents.walk(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions'), 4, (n) => n.endsWith('.jsonl')),
  parse: (f) => codexParser.parse(f),
};

/** Every agent we know how to find and replay. Keys are what --agent accepts. */
export const PARSERS = {
  claude,
  codex,
  gemini: agents.gemini,
  qwen: agents.qwen,
  opencode: agents.opencode,
  cline: agents.cline,
  roo: agents.roo,
  kilo: agents.kilo,
  copilot: agents.copilot,
  amp: agents.amp,
  aider: agents.aider,
  generic: agents.generic,
};

function mtimeOf(ref) {
  try {
    return fs.statSync(ref.split('#')[0]).mtimeMs;
  } catch {
    return 0;
  }
}

/** All sessions found on this machine, newest first. */
export function listSessions({ agent } = {}) {
  const found = [];
  for (const [key, src] of Object.entries(PARSERS)) {
    if (agent && agent !== key) continue;
    let files = [];
    try {
      files = src.find();
    } catch {
      /* a broken store for one agent shouldn't hide the others */
    }
    for (const file of files) found.push({ agent: key, file, mtime: mtimeOf(file) });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Pick the parser for an arbitrary file path. */
export function detectAgent(file) {
  const base = path.basename(file);
  if (base === 'api_conversation_history.json' || base === 'ui_messages.json') {
    for (const k of ['roo', 'kilo', 'cline']) if (PARSERS[k].match(file)) return k;
    return 'cline';
  }
  if (file.endsWith('.md')) return 'aider';
  if (file.includes('.db#') || base === 'opencode.db') return 'opencode';
  for (const k of ['gemini', 'qwen', 'amp', 'copilot', 'opencode']) if (PARSERS[k].match(file)) return k;
  if (file.endsWith('.jsonl')) {
    const records = readJsonl(file).slice(0, 50);
    if (codexParser.detect(records)) return 'codex';
    if (claudeParser.detect(records)) return 'claude';
  }
  if (universal.detect(file)) return 'generic';
  return null;
}

/** Cheap one-line preview for --list. */
export function preview(file, agent) {
  try {
    if (agent === 'claude' || agent === 'codex') return previewJsonl(file);
    const s = PARSERS[agent].parse(file);
    return s.title || '(no prompt)';
  } catch {
    return '(unreadable)';
  }
}

function previewJsonl(file) {
  const records = readJsonl(file);
  for (const r of records) if (r.type === 'ai-title' && r.aiTitle) return r.aiTitle;
  for (const r of records) {
    if (r.isMeta || r.isSidechain) continue;
    const isUser = r.type === 'user' || (r.payload?.type === 'message' && r.payload.role === 'user');
    if (!isUser) continue;
    const c = r.message?.content ?? r.payload.content;
    const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map((b) => (b.type === 'tool_result' ? '' : b.text || '')) : [];
    for (const b of blocks) {
      const clean = stripHarnessTags(b);
      if (clean && !clean.startsWith('<')) return clean.split('\n')[0].slice(0, 70);
    }
  }
  return '(no prompt)';
}
