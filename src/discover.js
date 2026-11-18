import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, stripHarnessTags } from './util.js';
import * as claude from './parsers/claude.js';
import * as codex from './parsers/codex.js';

export const PARSERS = { claude, codex };

function claudeRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}
function codexRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** All known session files on this machine, newest first. */
export function listSessions({ agent } = {}) {
  const found = [];
  if (!agent || agent === 'claude') {
    // projects/<project>/<session>.jsonl — skip subagent logs nested deeper
    for (const f of walk(claudeRoot(), 1, [])) found.push({ agent: 'claude', file: f });
  }
  if (!agent || agent === 'codex') {
    for (const f of walk(codexRoot(), 4, [])) found.push({ agent: 'codex', file: f });
  }
  for (const s of found) s.mtime = fs.statSync(s.file).mtimeMs;
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Pick the parser for an arbitrary file by sniffing its first records. */
export function detectAgent(file) {
  const records = readJsonl(file).slice(0, 50);
  if (codex.detect(records)) return 'codex';
  if (claude.detect(records)) return 'claude';
  return null;
}

/** Cheap one-line preview for --list without fully parsing. */
export function preview(file) {
  try {
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
  } catch {
    /* unreadable */
  }
  return '(no prompt)';
}
