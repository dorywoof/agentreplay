import { estimateCost } from './pricing.js';

const IDLE_CAP_MS = 5 * 60 * 1000;

/** Aggregate numbers for the summary card. */
export function computeStats(session, pricing) {
  const ev = session.events;
  const times = ev.flatMap((e) => [e.t, e.endT]).filter(Number.isFinite);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;

  // "Active" time: wall-clock minus long idle gaps (lunch breaks, overnight).
  let active = 0;
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) active += Math.min(sorted[i] - sorted[i - 1], IDLE_CAP_MS);

  const tools = ev.filter((e) => e.kind === 'tool');
  const byTool = {};
  for (const t of tools) byTool[t.name] = (byTool[t.name] || 0) + 1;

  const files = {};
  for (const t of tools) {
    if (!t.diff) continue;
    const list = t.diff.some((d) => d.file) ? t.diff.map((d) => d.file) : [t.file];
    for (const f of list) {
      if (!f) continue;
      files[f] ||= { added: 0, removed: 0, edits: 0, created: false };
      files[f].edits++;
      if (t.created) files[f].created = true;
    }
    const f = files[list[0]];
    if (f && t.lines) {
      f.added += t.lines.added;
      f.removed += t.lines.removed;
    }
  }

  const u = session.usage;
  return {
    start,
    end,
    wallMs: start != null ? end - start : 0,
    activeMs: active,
    prompts: ev.filter((e) => e.kind === 'user').length,
    toolCalls: tools.length,
    errors: tools.filter((t) => t.isError).length,
    byTool: Object.entries(byTool).sort((a, b) => b[1] - a[1]),
    files: Object.entries(files)
      .map(([file, s]) => ({ file, ...s }))
      .sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    linesAdded: Object.values(files).reduce((s, f) => s + f.added, 0),
    linesRemoved: Object.values(files).reduce((s, f) => s + f.removed, 0),
    tokens: {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite + u.cacheWrite1h,
      total: u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite1h,
    },
    cost: session.reportedCost ?? estimateCost(session.usageByModel, pricing),
    costReported: session.reportedCost != null,
    timesSynthetic: !!session.timesSynthetic,
  };
}
