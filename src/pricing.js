import fs from 'node:fs';

/**
 * USD per 1M tokens. Cache writes are priced from the input rate
 * (5-minute writes 1.25x, 1-hour writes 2x); cache reads use `cacheRead`
 * when given, else 0.1x input. `above` is a higher tier for prompts over
 * `above.tokens` (the whole prompt, cached or not). These are list prices for the first-party
 * API and are only an estimate of what a session cost — subscription plans
 * are billed differently. Override with --pricing <file.json>.
 *
 * Models are matched by longest prefix.
 */
export const DEFAULT_PRICING = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, above: { tokens: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function loadPricing(file) {
  if (!file) return DEFAULT_PRICING;
  const custom = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...DEFAULT_PRICING, ...custom };
}

/**
 * Price entry for a model id, or null. Provider prefixes ("anthropic/",
 * "us.anthropic.") and date suffixes are ignored. With `ctx` (the prompt size),
 * a long-prompt tier is applied when the model has one.
 */
export function rateFor(model, pricing, ctx = 0) {
  if (!model) return null;
  const id = String(model).toLowerCase();
  const at = id.indexOf('claude-');
  const bare = at > 0 ? id.slice(at) : id;
  const keys = Object.keys(pricing)
    .filter((k) => id.startsWith(k) || bare.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  const r = pricing[keys[0]];
  if (r.above && ctx > r.above.tokens) return { input: r.above.input, output: r.above.output, cacheRead: r.above.cacheRead };
  return r;
}

const promptSize = (req) => req.ctx ?? (req.input || 0) + (req.cacheRead || 0) + (req.cacheWrite || 0) + (req.cacheWrite1h || 0);

/** Returns estimated USD, or null when any used model has no known price. */
export function estimateCost(usageByModel, pricing) {
  let total = 0;
  let any = false;
  for (const [model, u] of Object.entries(usageByModel)) {
    const tokens = u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite1h;
    if (!tokens) continue;
    const r = rateFor(model, pricing);
    if (!r) return null;
    any = true;
    const cacheRead = r.cacheRead ?? r.input * 0.1;
    total +=
      (u.input * r.input +
        u.output * r.output +
        u.cacheRead * cacheRead +
        u.cacheWrite * r.input * 1.25 +
        u.cacheWrite1h * r.input * 2) /
      1e6;
  }
  return any ? total : null;
}

/** USD for one logged request split by token kind, or null when the model has no known price. */
export function requestCostParts(req, pricing) {
  const r = rateFor(req.model, pricing, promptSize(req));
  if (!r) return null;
  const cacheRead = r.cacheRead ?? r.input * 0.1;
  return {
    input: ((req.input || 0) * r.input) / 1e6,
    cacheWrite: ((req.cacheWrite || 0) * r.input * 1.25 + (req.cacheWrite1h || 0) * r.input * 2) / 1e6,
    cacheRead: ((req.cacheRead || 0) * cacheRead) / 1e6,
    output: ((req.output || 0) * r.output) / 1e6,
  };
}

/** USD for one logged request, or null when the model has no known price. */
export function requestCost(req, pricing) {
  const p = requestCostParts(req, pricing);
  return p && p.input + p.cacheWrite + p.cacheRead + p.output;
}

/** USD for a list of requests, or null when any of them has no known price. */
export function requestsCost(reqs, pricing) {
  let total = 0;
  for (const req of reqs) {
    const c = requestCost(req, pricing);
    if (c == null) return null;
    total += c;
  }
  return total;
}
