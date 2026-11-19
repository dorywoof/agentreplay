/**
 * `agentreplayer race <a> <b>`: two sessions played side by side on one clock.
 *
 * Each lane's clock is its own elapsed time since its first event, with idle
 * gaps (a human away from the keyboard) capped the same way for both lanes,
 * so "finished first" compares working time, not who went to lunch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, detectAgent, PARSERS } from './discover.js';
import { computeStats } from './stats.js';
import { requestCost } from './pricing.js';
import { fillTemplate, generator } from './render.js';

export const IDLE_CAP_MS = 2 * 60_000;

/**
 * A lane reference: a log file path, a number from `--list`, or an agent name
 * (its newest session that has messages).
 */
export function resolveRef(ref, { sessions = null, exclude = new Set() } = {}) {
  const all = () => (sessions ||= listSessions());
  if (isFile(String(ref).split('#')[0])) {
    const file = path.resolve(ref);
    const agent = detectAgent(file);
    if (!agent) throw new Error(`could not find a conversation in ${ref}`);
    return { file, agent };
  }
  if (/^\d+$/.test(ref)) {
    const s = all()[Number(ref) - 1];
    if (!s) throw new Error(`no session #${ref} (run agentreplayer --list)`);
    return s;
  }
  if (PARSERS[ref]) {
    // "race claude claude" = the two newest Claude sessions: skip ones already picked.
    for (const s of all().filter((x) => x.agent === ref && !exclude.has(x.file)).slice(0, 25)) {
      try {
        const parsed = PARSERS[ref].parse(s.file);
        if (parsed.events.length) return { ...s, parsed };
      } catch {
        /* try the next one */
      }
    }
    throw new Error(`no ${PARSERS[ref].label} session with messages found`);
  }
  throw new Error(`"${ref}" is not a file, a --list number or an agent (${Object.keys(PARSERS).join(', ')})`);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Map absolute timestamps to "working time" since the start, capping idle gaps. */
export function workClock(times, cap = IDLE_CAP_MS) {
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  const rel = new Map();
  let acc = 0;
  sorted.forEach((t, i) => {
    if (i) acc += Math.min(t - sorted[i - 1], cap);
    rel.set(t, acc);
  });
  return (t) => (Number.isFinite(t) ? rel.get(t) ?? null : null);
}

/** Everything one lane needs: events on its own clock, and running totals. */
export function buildLane(session, pricing) {
  const stats = computeStats(session, pricing);
  const reqs = (session.requestLog || []).filter((r) => Number.isFinite(r.t));
  const clock = workClock([...session.events.flatMap((e) => [e.t, e.endT]), ...reqs.map((r) => r.t)]);
  // Events without a timestamp inherit the previous one's.
  let last = 0;
  const events = session.events.map((e) => {
    const at = clock(e.t);
    if (at != null) last = at;
    const { t, endT, ...rest } = e;
    return { ...rest, at: at ?? last };
  });
  const costs = reqs.map((r) => requestCost(r, pricing));
  const priced = costs.length > 0 && costs.every((c) => c != null);
  return {
    agent: session.agent,
    title: session.title || null,
    models: session.models,
    timed: !session.timesSynthetic && events.some((e) => e.at > 0),
    events,
    // Running totals: tokens always, dollars only when every request has a known price.
    reqs: reqs.map((r, i) => ({ at: clock(r.t) ?? 0, tokens: r.ctx + r.output, cost: priced ? costs[i] : null })).sort((a, b) => a.at - b.at),
    final: {
      ms: events.reduce((m, e) => Math.max(m, e.at), 0),
      tokens: stats.tokens.total,
      cost: stats.cost,
      costReported: stats.costReported,
      prompts: stats.prompts,
      toolCalls: stats.toolCalls,
      errors: stats.errors,
      files: stats.files.length,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    },
  };
}

export const MAX_LANES = 6;

/**
 * What each lane is called. The agent name, unless two lanes share it: then the
 * model tells them apart (Claude Code · opus vs Claude Code · sonnet), or a number.
 */
export function laneLabels(lanes) {
  const model = (l) => (l.models || []).join(', ');
  const labels = lanes.map((l) => {
    const twins = lanes.filter((x) => x.agent === l.agent);
    if (twins.length < 2) return l.agent;
    // The model only helps when it differs between the lanes of this agent.
    return model(l) && new Set(twins.map(model)).size > 1 ? `${l.agent} · ${model(l)}` : l.agent;
  });
  // Still ambiguous (same agent and model): number them.
  return labels.map((x, i) => (labels.filter((y) => y === x).length > 1 ? `${x} #${labels.slice(0, i + 1).filter((y) => y === x).length}` : x));
}

export function renderRace(lanes, { title = null, redactions = null } = {}) {
  const labels = laneLabels(lanes);
  lanes = lanes.map((l, i) => ({ ...l, label: labels[i] }));
  const name = title || labels.join(' vs ');
  return fillTemplate('./race.html', `${name} · agentreplayer race`, { title: name, lanes, redactions, generator: generator() });
}
