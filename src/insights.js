/**
 * `agentreplayer insights`: where your agent tokens went across every session of
 * the last N days, and where they were wasted.
 *
 * Every number here comes from the logs. Anything estimated says how:
 *  - tool output tokens ≈ characters / 4
 *  - costs are public API list prices (see pricing.js); unknown models → tokens only
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARSERS, listSessions } from './discover.js';
import * as claudeParser from './parsers/claude.js';
import { walk } from './parsers/agents.js';
import { requestCost } from './pricing.js';

const DAY = 86_400_000;
export const CHARS_PER_TOKEN = 4;
export const BIG_OUTPUT_TOKENS = 5_000; // a tool output this big is worth flagging
export const LONG_CONTEXT = 100_000; // prompts above this are "long"
export const CACHE_TTL_MS = 5 * 60_000; // default prompt-cache lifetime
const LOOP_WINDOW = 6; // a retry counts if it comes within this many tool calls
const LOOP_MIN_FAILURES = 3;
const MIN_MISS_CONTEXT = 20_000;

/** Find and parse every session touched in the last `days` days. */
export function collectSessions({ days = 7, agent = null, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const files = listSessions({ agent }).filter((s) => s.mtime >= since);
  // Claude Code keeps subagent (Task/Agent) logs next to the session; their tokens count too.
  if (!agent || agent === 'claude') {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    for (const file of walk(root, 3, (n, p) => n.endsWith('.jsonl') && /[\\/]subagents[\\/]/.test(p))) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime >= since) files.push({ agent: 'claude', file, mtime, subagent: true });
    }
  }
  const sessions = [];
  let failed = 0;
  for (const f of files) {
    try {
      const session = f.subagent ? claudeParser.parse(f.file, { includeSidechains: true }) : PARSERS[f.agent].parse(f.file);
      sessions.push({ ...f, session });
    } catch {
      failed++;
    }
  }
  return { sessions, failed, since, now, days };
}

function projectOf(s, file) {
  const home = os.homedir();
  const cwd = s.cwd ? String(s.cwd) : null;
  if (cwd) {
    if (path.resolve(cwd).toLowerCase() === path.resolve(home).toLowerCase()) return '~';
    return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
  }
  return '(unknown)';
}

const firstTime = (s) => s.events.find((e) => e.t)?.t ?? s.requestLog?.find((r) => r.t)?.t ?? null;

const dayKey = (t) => (t == null ? 'unknown' : new Date(t).toLocaleDateString('en-CA'));

function bucket(map, key) {
  return (map[key] ||= { sessions: 0, tokens: 0, cost: 0, unpricedTokens: 0, requests: 0, toolCalls: 0, errors: 0, longTokens: 0, inputTokens: 0, cacheRead: 0 });
}

/** Normalized "same command" key for retry detection. Edits are excluded: re-editing a file is normal work. */
function loopKey(ev) {
  if (ev.diff) return null;
  const sum = String(ev.summary || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
  return sum ? `${ev.name}\u0000${sum}` : null;
}

/** Runs of the same tool call failing again and again. */
export function detectLoops(tools) {
  const open = new Map();
  const found = [];
  const close = (run) => {
    if (run.failures >= LOOP_MIN_FAILURES) found.push(run);
  };
  tools.forEach((ev, i) => {
    const key = loopKey(ev);
    if (!key) return;
    let run = open.get(key);
    if (run && i - run.lastIdx > LOOP_WINDOW) {
      close(run);
      run = null;
    }
    if (!run) {
      run = { name: ev.name, summary: String(ev.summary || '').split('\n')[0].slice(0, 120), attempts: 0, failures: 0, lastIdx: i, tStart: ev.t ?? null, tEnd: ev.t ?? null, resolved: false };
      open.set(key, run);
    }
    run.attempts++;
    run.lastIdx = i;
    run.tEnd = ev.endT ?? ev.t ?? run.tEnd;
    if (ev.isError) run.failures++;
    else if (run.failures) {
      run.resolved = true;
      close(run);
      open.delete(key);
    }
  });
  for (const run of open.values()) close(run);
  return found;
}

/** Requests after `t` that still carried the output, until the context was reset (compaction / clear). */
function carriedRequests(reqs, t) {
  const out = [];
  let peak = 0;
  for (const r of reqs) {
    if (r.t == null || r.t <= t) continue;
    if (peak > MIN_MISS_CONTEXT && r.ctx < peak * 0.5) break;
    peak = Math.max(peak, r.ctx);
    out.push(r);
  }
  return out;
}

/** Requests whose prompt was mostly not served from cache, although the conversation was not reset. */
export function detectCacheMisses(reqs, pricing) {
  const misses = [];
  for (let i = 1; i < reqs.length; i++) {
    const cur = reqs[i];
    const prev = reqs[i - 1];
    if (cur.t == null || prev.t == null) continue;
    if (cur.ctx < MIN_MISS_CONTEXT || cur.ctx < prev.ctx * 0.5) continue; // small, or a fresh/compacted context
    const missed = cur.input + cur.cacheWrite + (cur.cacheWrite1h || 0);
    if (missed < cur.ctx * 0.5) continue;
    const actual = requestCost(cur, pricing);
    const ideal = requestCost({ ...cur, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: cur.cacheRead + missed }, pricing);
    // The cache belongs to one model, so switching models always misses.
    const reason = prev.model && cur.model && prev.model !== cur.model ? 'model switch' : cur.t - prev.t > CACHE_TTL_MS ? 'pause' : 'other';
    misses.push({ t: cur.t, gapMs: cur.t - prev.t, reason, tokens: missed, extra: actual != null && ideal != null ? actual - ideal : null, model: cur.model });
  }
  return misses;
}

export function analyze({ sessions, since, now, days, failed = 0 }, pricing) {
  const R = {
    days,
    since,
    now,
    sessions: 0,
    subagents: 0,
    failedToRead: failed,
    total: bucket({}, 'x'),
    byDay: {},
    byProject: {},
    byAgent: {},
    loops: [],
    bloat: [],
    cacheMisses: [],
    unpricedModels: [],
  };
  const unpriced = new Set();
  // Resumed / forked sessions copy earlier history into a new log file. Count each request and tool call once.
  const seenReq = new Set();
  const seenTool = new Set();
  const once = (seen, key) => (key == null ? true : seen.has(key) ? false : (seen.add(key), true));
  const reqKey = (s, r) => (r.id ? `id:${r.id}` : r.t == null ? null : `${s.agent}|${r.t}|${r.ctx}|${r.output}|${r.model}`);
  const toolKey = (s, e) => (e.t == null ? null : `${s.agent}|${e.t}|${e.name}|${e.summary}|${e.outputSize ?? ''}`);
  // Oldest file first, so the original session keeps its requests and the copy loses them.
  const ordered = [...sessions].sort((a, b) => (firstTime(a.session) ?? 0) - (firstTime(b.session) ?? 0));

  for (const { session: s, file, subagent } of ordered) {
    const reqs = (s.requestLog || [])
      .filter((r) => (r.t == null || r.t >= since) && once(seenReq, reqKey(s, r)))
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const tools = s.events.filter((e) => e.kind === 'tool' && (e.t == null || e.t >= since) && once(seenTool, toolKey(s, e)));
    if (!reqs.length && !tools.length) continue;
    if (subagent) R.subagents++;
    else R.sessions++;

    const project = projectOf(s, file);
    const agent = s.agent;
    const firstT = s.events.find((e) => e.t)?.t ?? reqs.find((r) => r.t)?.t ?? null;
    const touched = new Set();
    const add = (map, key, fn) => {
      const b = bucket(map, key);
      const tag = `${map === R.byDay ? 'd' : map === R.byProject ? 'p' : 'a'}:${key}`;
      if (!subagent && !touched.has(tag)) {
        touched.add(tag);
        b.sessions++;
      }
      fn(b);
    };
    const each = (t, fn) => {
      fn(R.total);
      add(R.byDay, dayKey(t), fn);
      add(R.byProject, project, fn);
      add(R.byAgent, agent, fn);
    };
    if (!subagent) R.total.sessions++;

    // Spend. Agents that record their own cost (Cline, Roo, OpenCode…) are trusted over our estimate.
    const reported = s.reportedCost;
    for (const r of reqs) {
      const tokens = r.ctx + r.output;
      const cost = reported != null ? 0 : requestCost(r, pricing);
      if (cost == null) unpriced.add(r.model || 'unknown');
      each(r.t ?? firstT, (b) => {
        b.requests++;
        b.tokens += tokens;
        b.inputTokens += r.ctx;
        b.cacheRead += r.cacheRead;
        if (cost == null) b.unpricedTokens += tokens;
        else b.cost += cost;
        if (r.ctx > LONG_CONTEXT) b.longTokens += r.ctx;
      });
    }
    if (reported != null) each(firstT, (b) => (b.cost += reported));
    if (!reqs.length && s.usage) {
      // Sessions with usage totals but no per-request log.
      const u = s.usage;
      const tokens = u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite1h;
      each(firstT, (b) => {
        b.tokens += tokens;
        b.unpricedTokens += reported == null ? tokens : 0;
      });
    }
    for (const ev of tools) {
      each(ev.t ?? firstT, (b) => {
        b.toolCalls++;
        if (ev.isError) b.errors++;
      });
    }

    // Waste 1: retry loops.
    for (const loop of detectLoops(tools)) {
      const during = reqs.filter((r) => r.t != null && loop.tStart != null && r.t >= loop.tStart && r.t <= (loop.tEnd ?? loop.tStart));
      const costs = during.map((r) => requestCost(r, pricing));
      R.loops.push({
        ...loop,
        lastIdx: undefined,
        project,
        agent,
        requests: during.length,
        tokens: during.reduce((a, r) => a + r.ctx + r.output, 0),
        cost: costs.length && costs.every((c) => c != null) ? costs.reduce((a, c) => a + c, 0) : null,
        durationMs: loop.tStart != null && loop.tEnd != null ? loop.tEnd - loop.tStart : null,
      });
    }

    // Waste 2: giant tool outputs that every later request had to re-read.
    for (const ev of tools) {
      const size = ev.outputSize ?? (ev.output || '').length;
      const tok = Math.round(size / CHARS_PER_TOKEN);
      if (tok < BIG_OUTPUT_TOKENS) continue;
      const t = ev.endT ?? ev.t;
      const later = t != null ? carriedRequests(reqs, t) : [];
      const costs = later.map((r) => requestCost({ model: r.model, input: 0, output: 0, cacheRead: tok, cacheWrite: 0 }, pricing));
      R.bloat.push({
        project,
        agent,
        name: ev.name,
        summary: String(ev.summary || '').split('\n')[0].slice(0, 120),
        outputTokens: tok,
        carriedRequests: later.length,
        carriedTokens: tok * later.length,
        carriedCost: costs.length && costs.every((c) => c != null) ? costs.reduce((a, c) => a + c, 0) : costs.length ? null : 0,
      });
    }

    // Waste 3: cache misses in the middle of a conversation.
    for (const m of detectCacheMisses(reqs, pricing)) R.cacheMisses.push({ ...m, project, agent });
  }

  R.unpricedModels = [...unpriced].filter((m) => m !== 'unknown' || unpriced.size === 1);
  R.loops.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.failures - a.failures);
  R.bloat.sort((a, b) => b.carriedTokens - a.carriedTokens);
  R.recommendations = recommend(R);
  return R;
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const shortName = (name) => String(name).split(' · ').pop();

/** Concrete, number-backed advice. Only emitted when the data supports it. */
export function recommend(R) {
  const recs = [];
  const total = R.total;

  // Big outputs, grouped by the tool that produced them (bloat is sorted, so the example is the worst one).
  const groups = {};
  for (const b of R.bloat) {
    const key = shortName(b.name);
    const g = (groups[key] ||= { key, count: 0, carriedTokens: 0, carriedCost: 0, priced: true, example: b });
    g.count++;
    g.carriedTokens += b.carriedTokens;
    if (b.carriedCost == null) g.priced = false;
    else g.carriedCost += b.carriedCost;
  }
  const topBloat = Object.values(groups).sort((a, b) => b.carriedTokens - a.carriedTokens)[0];
  if (topBloat && topBloat.carriedTokens > 500_000) {
    recs.push({
      kind: 'bloat',
      weight: topBloat.priced ? topBloat.carriedCost : topBloat.carriedTokens / 1e6,
      text: `Keep ${topBloat.key} outputs short. ${topBloat.count} of them were over ${fmtTok(BIG_OUTPUT_TOKENS)} tokens${topBloat.example.summary ? ` (biggest: "${topBloat.example.summary.slice(0, 60)}")` : ''} and later requests re-read them ${fmtTok(topBloat.carriedTokens)} tokens in total${topBloat.priced && topBloat.carriedCost ? ` (~${fmtUsd(topBloat.carriedCost)})` : ''}. Ask the agent to filter (head, grep, a quiet flag, a narrower query), or add that rule to CLAUDE.md / AGENTS.md.`,
    });
  }

  const worstLoop = R.loops[0];
  if (worstLoop) {
    const loopCost = sum(R.loops, (l) => l.cost);
    recs.push({
      kind: 'loop',
      weight: loopCost || worstLoop.failures,
      text: `${R.loops.length} retry loop${R.loops.length > 1 ? 's' : ''} found. Worst: "${worstLoop.summary}" failed ${worstLoop.failures}× in ${worstLoop.project}${worstLoop.resolved ? '' : ' and never succeeded'}. When the same command fails twice, stop and fix the cause (missing dependency, wrong path, flaky test) instead of letting the agent retry.`,
    });
  }

  const paused = R.cacheMisses.filter((m) => m.reason === 'pause');
  const pausedCost = sum(paused, (m) => m.extra);
  const switched = R.cacheMisses.filter((m) => m.reason === 'model switch');
  const switchCost = sum(switched, (m) => m.extra);
  if (switched.length >= 3) {
    recs.push({
      kind: 'switch',
      weight: switchCost,
      text: `Switching models mid-conversation threw the cache away ${switched.length} times (${fmtTok(sum(switched, (m) => m.tokens))} tokens re-processed${switchCost ? `, ~${fmtUsd(switchCost)} extra` : ''}). Pick the model at the start of a session, or start a new one when you switch.`,
    });
  }
  if (paused.length >= 3) {
    recs.push({
      kind: 'cache',
      weight: pausedCost,
      text: `${paused.length} times a pause of 5+ min let the prompt cache expire, so the whole conversation was re-processed at full price (${fmtTok(sum(paused, (m) => m.tokens))} tokens${pausedCost ? `, ~${fmtUsd(pausedCost)} extra` : ''}). After a long break on a big session, start fresh with a short summary instead of resuming.`,
    });
  }

  const longProjects = Object.entries(R.byProject)
    .filter(([, b]) => b.inputTokens > 2_000_000 && b.longTokens / b.inputTokens > 0.4)
    .sort((a, b) => b[1].longTokens - a[1].longTokens);
  if (longProjects.length) {
    const [name, b] = longProjects[0];
    recs.push({
      kind: 'long',
      weight: b.cost * (b.longTokens / b.inputTokens),
      text: `In ${name}, ${Math.round((b.longTokens / b.inputTokens) * 100)}% of input tokens were sent with a prompt over ${fmtTok(LONG_CONTEXT)} tokens. Every request re-sends everything, so start new sessions (or compact) earlier there.`,
    });
  }

  if (total.toolCalls > 50 && total.errors / total.toolCalls > 0.15) {
    recs.push({
      kind: 'errors',
      weight: 0,
      text: `${Math.round((total.errors / total.toolCalls) * 100)}% of tool calls failed. Check the failing ones with agentreplayer --list and replay the worst session.`,
    });
  }
  return recs.sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

export function fmtUsd(n) {
  if (n == null) return '—';
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

function fmtDur(ms) {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Plain-text report for the terminal. `style` = { bold, dim } colour helpers. */
export function formatReport(R, { bold = (s) => s, dim = (s) => s, width = 72 } = {}) {
  const L = [];
  const T = R.total;
  const costTxt = (b) => (b.cost ? fmtUsd(b.cost) : '') + (b.unpricedTokens ? dim(`${b.cost ? ' + ' : ''}${fmtTok(b.unpricedTokens)} unpriced tok`) : '');
  const bar = (v, max, w = 18) => '█'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / (max || 1)) * w)));
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  L.push(bold(`agentreplayer insights · last ${R.days} day${R.days > 1 ? 's' : ''}`));
  L.push(
    dim(
      `${R.sessions} sessions${R.subagents ? ` + ${R.subagents} subagent logs` : ''} · ${fmtTok(T.tokens)} tokens · ${T.requests} requests · ${T.toolCalls} tool calls (${T.errors} failed)`,
    ),
  );
  L.push('');
  L.push(`${bold('Spend')}  ${costTxt(T) || dim('no priced models')}${T.cost ? dim('  (API list prices; subscriptions bill differently)') : ''}`);
  if (T.inputTokens) L.push(dim(`  ${Math.round((T.cacheRead / T.inputTokens) * 100)}% of input came from cache · ${Math.round((T.longTokens / T.inputTokens) * 100)}% was sent in prompts over ${fmtTok(LONG_CONTEXT)}`));

  const table = (title, map, limit) => {
    const rows = Object.entries(map).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
    if (!rows.length) return;
    L.push('');
    L.push(bold(title));
    const max = Math.max(...rows.map(([, b]) => b.tokens));
    for (const [k, b] of rows.slice(0, limit)) {
      L.push(`  ${cut(k, 22).padEnd(22)} ${bar(b.tokens, max).padEnd(18)} ${fmtTok(b.tokens).padStart(6)}  ${costTxt(b).padEnd(10)} ${dim(`${b.sessions} sess`)}`);
    }
    if (rows.length > limit) L.push(dim(`  … ${rows.length - limit} more`));
  };
  table('By project', R.byProject, 8);
  table('By agent', R.byAgent, 6);
  const days = Object.entries(R.byDay).sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length > 1) {
    L.push('');
    L.push(bold('By day'));
    const max = Math.max(...days.map(([, b]) => b.tokens));
    for (const [d, b] of days) L.push(`  ${d.padEnd(12)} ${bar(b.tokens, max, 30).padEnd(30)} ${fmtTok(b.tokens).padStart(6)}  ${costTxt(b)}`);
  }

  // Agents side by side: same yardsticks for each.
  const agents = Object.entries(R.byAgent).filter(([, b]) => b.requests);
  if (agents.length > 1) {
    L.push('');
    L.push(bold('Agents side by side'));
    L.push(dim(`  ${''.padEnd(14)} ${'tok/session'.padStart(11)} ${'tok/tool call'.padStart(13)} ${'cache hit'.padStart(9)} ${'failed calls'.padStart(12)}`));
    for (const [a, b] of agents) {
      L.push(
        `  ${cut(a, 14).padEnd(14)} ${fmtTok(b.tokens / Math.max(1, b.sessions)).padStart(11)} ${(b.toolCalls ? fmtTok(b.tokens / b.toolCalls) : '—').padStart(13)} ${(b.inputTokens ? Math.round((b.cacheRead / b.inputTokens) * 100) + '%' : '—').padStart(9)} ${(b.toolCalls ? Math.round((b.errors / b.toolCalls) * 100) + '%' : '—').padStart(12)}`,
      );
    }
  }

  L.push('');
  L.push(bold('Where it was wasted'));
  const loopCost = sum(R.loops, (l) => l.cost);
  L.push(`  ${bold('Retry loops')}  ${R.loops.length ? `${R.loops.length} found, ${sum(R.loops, (l) => l.failures)} failed attempts${loopCost ? `, ~${fmtUsd(loopCost)} spent while stuck` : ''}` : dim('none — nice')}`);
  for (const l of R.loops.slice(0, 3)) {
    L.push(dim(`    ${l.failures}× ${l.resolved ? 'then fixed' : 'never fixed'} · ${cut(l.project, 18)} · ${l.durationMs != null ? fmtDur(l.durationMs) + ' · ' : ''}`) + cut(`${shortName(l.name)}: ${l.summary}`, 60));
  }
  const bloatTok = sum(R.bloat, (b) => b.carriedTokens);
  const bloatCost = sum(R.bloat, (b) => b.carriedCost);
  L.push(`  ${bold('Huge tool outputs')}  ${R.bloat.length ? `${R.bloat.length} outputs over ${fmtTok(BIG_OUTPUT_TOKENS)} tokens, re-read ${fmtTok(bloatTok)} tokens later${bloatCost ? ` (~${fmtUsd(bloatCost)})` : ''}` : dim('none')}`);
  for (const b of R.bloat.slice(0, 3)) {
    L.push(dim(`    ${fmtTok(b.outputTokens)} tok × ${b.carriedRequests} later requests · ${cut(b.project, 18)} · `) + cut(b.summary ? `${shortName(b.name)}: ${b.summary}` : shortName(b.name), 56));
  }
  const missCost = sum(R.cacheMisses, (m) => m.extra);
  const reasons = ['pause', 'model switch', 'other']
    .map((r) => [r, R.cacheMisses.filter((m) => m.reason === r).length])
    .filter(([, n]) => n)
    .map(([r, n]) => `${n} ${r === 'pause' ? 'after a 5+ min pause' : r === 'model switch' ? 'after a model switch' : 'other'}`);
  L.push(
    `  ${bold('Cache misses')}  ${R.cacheMisses.length ? `${R.cacheMisses.length} mid-conversation, ${fmtTok(sum(R.cacheMisses, (m) => m.tokens))} tokens re-processed${missCost ? `, ~${fmtUsd(missCost)} extra` : ''}` : dim('none')}`,
  );
  if (reasons.length) L.push(dim(`    ${reasons.join(' · ')}`));

  if (R.recommendations.length) {
    L.push('');
    L.push(bold('What to do'));
    R.recommendations.slice(0, 4).forEach((r, i) => wrap(`${i + 1}. ${r.text}`, width - 2).forEach((line, j) => L.push((j ? '     ' : '  ') + line)));
  }
  L.push('');
  const notes = [];
  if (R.unpricedModels.length) notes.push(`no price for ${R.unpricedModels.slice(0, 3).join(', ')} (tokens only; add prices with --pricing)`);
  notes.push('output tokens ≈ chars/4');
  if (R.failedToRead) notes.push(`${R.failedToRead} logs could not be read`);
  L.push(dim(`Notes: ${notes.join(' · ')}`));
  return L.join('\n');
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line && (line + ' ' + w).length > width) {
      out.push(line);
      line = w;
    } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}
