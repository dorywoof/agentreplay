/**
 * Live helpers for Claude Code: a status line, a "your cache went cold" prompt
 * guard, and an end-of-session summary. They run often, so they read only the
 * tail of the transcript instead of parsing the whole session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rateFor } from './pricing.js';

export const LONG_CTX = 100_000; // "long" — every message re-reads this much
export const HUGE_CTX = 150_000; // "start fresh" territory
export const GUARD_MIN_CTX = 50_000; // smaller prompts are cheap to re-cache, don't interrupt
const TAIL_BYTES = 512 * 1024;
const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;

/** Last `bytes` of a file as complete lines (the first, possibly partial, line is dropped). */
export function readTailLines(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What the most recent API request of a Claude Code session looked like:
 * prompt size (ctx), model, when it happened, and how long its cache lives.
 */
export function lastRequest(transcriptPath) {
  let lines;
  try {
    lines = readTailLines(transcriptPath);
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = r.type === 'assistant' && !r.isSidechain && r.message?.usage;
    if (!u || r.message.model === '<synthetic>') continue;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!ctx) continue;
    const oneHour = (u.cache_creation?.ephemeral_1h_input_tokens || 0) > 0;
    return { ctx, model: r.message.model || null, t: Date.parse(r.timestamp) || null, ttlMs: oneHour ? TTL_1H : TTL_5M };
  }
  return null;
}

/** USD to send `ctx` tokens again: cold (re-written to cache) vs warm (read from cache). */
export function resendCost(ctx, model, pricing, ttlMs = TTL_5M) {
  const r = rateFor(model, pricing, ctx);
  if (!r || !ctx) return null;
  const cacheRead = r.cacheRead ?? r.input * 0.1;
  const writeMult = ttlMs >= TTL_1H ? 2 : 1.25;
  return { cold: (ctx * r.input * writeMult) / 1e6, warm: (ctx * cacheRead) / 1e6 };
}

const usd = (n) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const mins = (ms) => `${Math.round(ms / 60_000)}m`;

// ---------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------

/** Printed width of a string: ANSI colours and OSC 8 links take no columns. */
export function visibleWidth(s) {
  return [...String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*m/g, '')].length;
}

const pct = (n) => `${Math.round(n)}%`;
function untilReset(epochSec, now) {
  const ms = epochSec * 1000 - now;
  if (!(ms > 0)) return '';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * One status line from Claude Code's statusline JSON. Plain ASCII apart from
 * "·", because emoji and symbols like ⚠ have a different width in different
 * terminals. Pieces are dropped from the least useful end when it doesn't fit.
 *
 *   API:          $3.20 · today ~$41 · 142k ctx · each msg ~$0.11
 *   Subscription: 5h 42% · 7d 18% · 162k ctx · long session: /clear saves limit
 *   Cold cache:   $3.20 · 142k ctx · cache cold 12m: next msg ~$1.38
 */
export function statusLine(input, pricing, { now = Date.now(), color = true, today = null, width = null } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s) => c('2', s);
  const model = input?.model?.id || null;
  const parts = []; // { text, keep } — higher keep survives longer when space is short

  // Subscription limits (Pro / Max): the number that matters there, so it goes first.
  const rl = input?.rate_limits;
  const sub = !!(rl && (rl.five_hour || rl.seven_day));
  for (const [key, label, keep] of [
    ['five_hour', '5h', 9],
    ['seven_day', '7d', 7],
  ]) {
    const w = rl?.[key];
    if (typeof w?.used_percentage !== 'number') continue;
    const p = w.used_percentage;
    const reset = p >= 70 && w.resets_at ? ` (resets ${untilReset(w.resets_at, now)})` : '';
    const text = `${label} ${pct(p)}${reset}`;
    parts.push({ text: p >= 90 ? c('31', text) : p >= 70 ? c('33', text) : text, keep });
  }

  const cost = input?.cost?.total_cost_usd;
  // On a subscription the dollar figure is only what it would cost on the API.
  if (typeof cost === 'number') parts.push({ text: sub ? dim(`~${usd(cost)} API`) : usd(cost), keep: sub ? 2 : 8 });
  if (today && (today.cost || today.unpricedTokens)) {
    const t = today.cost ? `today ~${usd(today.cost)}` : `today ${tok(today.tokens)} tok`;
    parts.push({ text: dim(t), keep: 3 });
  }

  // Context: Claude Code's own numbers first, the transcript as a fallback.
  const cu = input?.context_window?.current_usage;
  let ctx = cu ? (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0) : 0;
  const last = input?.transcript_path ? lastRequest(input.transcript_path) : null;
  if (!ctx && last) ctx = last.ctx;
  const ttlMs = input?.prompt_cache?.ttl ? toMs(input.prompt_cache.ttl) : last?.ttlMs ?? TTL_5M;

  if (ctx) {
    const label = `${tok(ctx)} ctx`;
    parts.push({ text: ctx >= HUGE_CTX ? c('31', label) : ctx >= LONG_CTX ? c('33', label) : label, keep: 10 });
    const cost2 = resendCost(ctx, model || last?.model, pricing, ttlMs);

    // Is the cache still warm? Prefer Claude Code's view, else time since the last request.
    const pc = input?.prompt_cache;
    let cold = false;
    const idle = last?.t ? now - last.t : null;
    if (pc && typeof pc.warm === 'boolean') cold = !pc.warm && pc.requests > 0;
    else if (idle != null) cold = idle > ttlMs;

    if (cold && ctx >= GUARD_MIN_CTX) {
      const next = sub ? `next msg re-sends ${tok(ctx)}` : cost2 ? `next msg ~${usd(cost2.cold)}` : 'next msg re-sends it all';
      parts.push({ text: c('36', `cache cold${idle != null ? ` ${mins(idle)}` : ''}: ${next}`), keep: 6 });
    } else {
      if (cost2 && !sub) parts.push({ text: dim(`each msg ~${usd(cost2.warm)}`), keep: 1 });
      if (ctx >= HUGE_CTX) parts.push({ text: c('31', `long session: /clear saves ${sub ? 'limit' : 'money'}`), keep: 5 });
    }
  }

  // Fit the width: drop the least useful pieces first, keeping their order.
  const sep = dim(' · ');
  let shown = parts;
  const fits = (xs) => !width || visibleWidth(xs.map((p) => p.text).join(sep)) <= width;
  while (shown.length > 1 && !fits(shown)) {
    const min = Math.min(...shown.map((p) => p.keep));
    const i = shown.findIndex((p) => p.keep === min);
    shown = shown.filter((_, k) => k !== i);
  }
  return shown.map((p) => p.text).join(sep);
}

// ---------------------------------------------------------------------------
// wrapping an existing status line
// ---------------------------------------------------------------------------

/**
 * The shell Claude Code itself uses for status line commands: on Windows, Git
 * Bash when installed, otherwise PowerShell; elsewhere the user's shell.
 */
export function shellFor(command, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'].find((p) => p && exists(p));
    return bash ? [bash, ['-c', command]] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]];
  }
  return [env.SHELL || '/bin/sh', ['-c', command]];
}

/** Put our segment after the other status line: on its last row when it fits, else on a row of its own. */
export function combineLines(theirs, ours, width) {
  const rows = String(theirs || '').replace(/\r/g, '').replace(/\n+$/, '').split('\n').filter((r, i, a) => r.trim() || i < a.length - 1);
  if (!rows.length || !rows.some((r) => r.trim())) return ours;
  if (!ours) return rows.join('\n');
  const last = rows[rows.length - 1];
  if (width && visibleWidth(last) + 3 + visibleWidth(ours) <= width) {
    rows[rows.length - 1] = `${last} | ${ours}`;
    return rows.join('\n');
  }
  return [...rows, ours].join('\n');
}

function toMs(ttl) {
  if (typeof ttl === 'number') return ttl < 10_000 ? ttl * 1000 : ttl;
  const m = String(ttl).match(/^(\d+)\s*(m|h|s)/i);
  if (!m) return TTL_5M;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2].toLowerCase()];
}

// ---------------------------------------------------------------------------
// prompt guard (UserPromptSubmit hook)
// ---------------------------------------------------------------------------

const stateDir = () => path.join(os.tmpdir(), 'agentreplayer');

/**
 * Before a prompt is sent: if the cache has expired on a big conversation,
 * block it once and say what it will cost. Sending the same thing again goes through.
 * @returns {{ block: true, reason: string } | null}
 */
export function promptGuard(input, pricing, { now = Date.now(), dir = stateDir() } = {}) {
  if (!input?.transcript_path || input.agent_id) return null; // subagents never get interrupted
  const last = lastRequest(input.transcript_path);
  if (!last?.t || last.ctx < GUARD_MIN_CTX) return null;
  const idle = now - last.t;
  if (idle <= last.ttlMs) return null;

  // Only once per cold spell: remember that we warned after this last request.
  const key = path.join(dir, `${String(input.session_id || 'session').replace(/[^\w-]/g, '')}.guard`);
  try {
    if (Number(fs.readFileSync(key, 'utf8')) === last.t) return null;
  } catch {
    /* not warned yet */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(key, String(last.t));
  } catch {
    return null; // can't remember the warning: better not to block at all
  }
  const cost = resendCost(last.ctx, last.model, pricing, last.ttlMs);
  const price = cost ? ` (~${usd(cost.cold)} instead of ~${usd(cost.warm)} with a warm cache)` : '';
  return {
    block: true,
    reason:
      `agentreplayer: the prompt cache expired after ${mins(idle)} idle, so this message would re-process ` +
      `the whole ${tok(last.ctx)}-token conversation${price}.\n` +
      `Send it again to go ahead, or /clear (or start a new session) to continue for less.`,
  };
}

// ---------------------------------------------------------------------------
// end-of-session summary (SessionEnd hook)
// ---------------------------------------------------------------------------

export const replaysDir = () => path.join(os.homedir(), '.agentreplayer', 'replays');

/** One line about a finished session, e.g. "42 min · 18 tool calls · 3 files · ~$6.10". */
export function summaryLine(session, stats) {
  const bits = [];
  if (!stats.timesSynthetic) bits.push(`${Math.max(1, Math.round(stats.activeMs / 60_000))} min`);
  bits.push(`${stats.toolCalls} tool calls${stats.errors ? ` (${stats.errors} failed)` : ''}`);
  if (stats.files.length) bits.push(`${stats.files.length} files +${stats.linesAdded} −${stats.linesRemoved}`);
  if (stats.cost != null) bits.push(`~${usd(stats.cost)}`);
  return bits.join(' · ');
}
