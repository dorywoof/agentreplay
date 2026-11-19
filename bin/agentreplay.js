#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { listSessions, detectAgent, preview, PARSERS } from '../src/discover.js';
import { createRedactor } from '../src/redact.js';
import { computeStats } from '../src/stats.js';
import { loadPricing } from '../src/pricing.js';
import { renderHtml } from '../src/render.js';
import { installSkill, uninstallSkill } from '../src/install-skill.js';
import { collectSessions, analyze, formatReport } from '../src/insights.js';
import { shareReplay } from '../src/share.js';
import { resolveRef, buildLane, renderRace, laneLabels, MAX_LANES } from '../src/race.js';

const HELP = `
agentreplay — turn an AI coding session into a shareable replay

Usage
  agentreplay                    replay your most recent session
  agentreplay <session.jsonl>    replay a specific log file
  agentreplay --list             list recent sessions
  agentreplay --pick 3           replay #3 from --list
  agentreplay --session <id>     replay the session whose id / file name matches
  agentreplay --agents           show supported agents and what was found
  agentreplay insights           where your tokens went in the last 7 days, across
                                 every agent: spend by project/agent/day, retry
                                 loops, huge tool outputs, cache misses, and what
                                 to change. --days <n>, --agent <name>, --json.
  agentreplay race <a> <b> [c…]  2 to 6 sessions side by side on one clock:
                                 "race claude codex" (newest of each), "race
                                 claude claude gemini" (two newest Claude), log
                                 files, or --list numbers ("race 1 3 4")
  agentreplay install-skill      add a "replay" skill to every agent on this machine
                                 (Claude Code, Codex, Gemini CLI, OpenCode, Copilot,
                                 Cursor…). --project installs into the current repo,
                                 --agent <name> limits it to one agent.
  agentreplay uninstall-skill    remove it again

Options
  -o, --out <file>      output HTML path (default: ./replay-<id>.html)
  -a, --agent <name>    only one agent: claude, codex, gemini, qwen, opencode,
                        cline, roo, kilo, copilot, amp, aider, generic
  -t, --title <text>    override the replay title
      --no-thinking     hide thinking / reasoning blocks
      --no-redact       keep secrets, e-mails and home paths (not for sharing!)
      --keep-paths      redact secrets but keep file paths as-is
      --pricing <file>  JSON with custom $/1M token prices per model
      --json            print the normalized session JSON instead of HTML
      --share           upload as a secret GitHub Gist and print a link that plays
                        it (needs "gh auth login" or GITHUB_TOKEN; anyone with
                        the link can view it)
      --no-open         don't open the replay in a browser
  -h, --help            show this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    agent: { type: 'string', short: 'a' },
    title: { type: 'string', short: 't' },
    list: { type: 'boolean', short: 'l' },
    agents: { type: 'boolean' },
    pick: { type: 'string', short: 'p' },
    session: { type: 'string', short: 's' },
    project: { type: 'boolean' },
    days: { type: 'string', short: 'd' },
    force: { type: 'boolean' },
    'no-thinking': { type: 'boolean' },
    'no-redact': { type: 'boolean' },
    'keep-paths': { type: 'boolean' },
    pricing: { type: 'string' },
    json: { type: 'boolean' },
    'no-open': { type: 'boolean' },
    share: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function fail(msg) {
  console.error(`agentreplay: ${msg}`);
  process.exit(1);
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function main() {
  if (opts.help) return console.log(HELP);

  if (positionals[0] === 'install-skill' || positionals[0] === 'uninstall-skill') {
    const project = opts.project ? process.cwd() : null;
    const results =
      positionals[0] === 'install-skill'
        ? installSkill({ project, only: opts.agent, force: opts.force })
        : uninstallSkill({ project });
    const done = results.filter((r) => r.status !== 'skipped');
    for (const r of done) console.log(`${bold('✓')} ${r.agent.padEnd(20)} ${dim(r.status.padEnd(9))} ${r.file}`);
    const skipped = results.filter((r) => r.status === 'skipped').map((r) => r.agent);
    if (skipped.length) console.log(dim(`  not installed (agent not found): ${skipped.join(', ')}. Use --force to install anyway.`));
    if (!done.length) console.log(positionals[0] === 'install-skill' ? 'Nothing installed.' : 'No agentreplay skill found to remove.');
    else if (positionals[0] === 'install-skill') console.log(`\nRestart your agent, then ask it to ${bold('"make a replay of this session"')} (in Claude Code: ${bold('/agentreplay')}).`);
    return;
  }

  if (positionals[0] === 'race') return race(positionals.slice(1));

  if (positionals[0] === 'insights') {
    if (opts.agent && !PARSERS[opts.agent]) fail(`unknown agent "${opts.agent}" (one of: ${Object.keys(PARSERS).join(', ')})`);
    const days = Number(opts.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number');
    if (process.stderr.isTTY) process.stderr.write(dim(`reading sessions from the last ${days} days…\r`));
    const data = collectSessions({ days, agent: opts.agent });
    if (process.stderr.isTTY) process.stderr.write(' '.repeat(50) + '\r');
    if (!data.sessions.length) fail(`no agent sessions in the last ${days} days`);
    const report = analyze(data, loadPricing(opts.pricing));
    if (opts.json) return process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.log(formatReport(report, { bold, dim, width: Math.min(process.stdout.columns || 80, 100) }));
    return;
  }

  if (opts.agent && !PARSERS[opts.agent]) fail(`unknown agent "${opts.agent}" (one of: ${Object.keys(PARSERS).join(', ')})`);

  if (opts.agents) {
    console.log(bold('Supported agents') + dim('  (sessions found on this machine)') + '\n');
    for (const [key, src] of Object.entries(PARSERS)) {
      if (key === 'generic') continue;
      const n = listSessions({ agent: key }).length;
      console.log(`  ${key.padEnd(9)} ${src.label.padEnd(13)} ${n ? bold(String(n)) : dim('0')}`);
    }
    console.log('\n' + dim('Any other JSON / JSONL chat log works too: agentreplay path/to/log.json'));
    return;
  }

  if (opts.list) {
    const sessions = listSessions({ agent: opts.agent }).slice(0, 20);
    if (!sessions.length) fail('no agent sessions found on this machine. Pass a log file path instead.');
    sessions.forEach((s, i) => {
      const tag = PARSERS[s.agent].label.padEnd(12);
      console.log(`${bold(String(i + 1).padStart(2))}  ${tag}  ${dim(ago(s.mtime).padEnd(8))}  ${preview(s.file, s.agent)}`);
    });
    console.log(dim('\nReplay one with: agentreplay --pick <n>'));
    return;
  }

  let file, agent, session;
  if (positionals[0]) {
    file = path.resolve(positionals[0]);
    if (!fs.existsSync(file.split('#')[0])) fail(`file not found: ${file}`);
    agent = opts.agent || detectAgent(file);
    if (!agent) fail('could not find a conversation in this file. Run agentreplay --agents to see supported formats.');
  } else {
    const sessions = listSessions({ agent: opts.agent });
    if (!sessions.length) fail('no agent sessions found on this machine. Pass a log file path instead.');
    let chosen = null;
    const wanted = (opts.session || '').trim();
    // An unexpanded "${CLAUDE_SESSION_ID}" or an unknown id falls back to the newest session.
    if (wanted && !wanted.includes('$')) {
      chosen = sessions.find((s) => path.basename(s.file).includes(wanted) || s.file.endsWith('#' + wanted));
      if (!chosen) console.error(dim(`session "${wanted}" not found — using the most recent one`));
    }
    if (!chosen && opts.pick) {
      chosen = sessions[Number(opts.pick) - 1];
      if (!chosen) fail(`no session #${opts.pick} — run with --list to see what's available`);
    }
    if (chosen) {
      ({ file, agent } = chosen);
    } else {
      // Newest session that actually has something in it (agents leave empty logs behind).
      for (const s of sessions.slice(0, 25)) {
        let parsed;
        try {
          parsed = PARSERS[s.agent].parse(s.file);
        } catch {
          continue;
        }
        if (parsed.events.length) {
          ({ file, agent } = s);
          session = parsed;
          break;
        }
      }
      if (!session) fail('none of the recent sessions has any messages to replay');
    }
  }

  session ||= PARSERS[agent].parse(file);
  if (opts.title) session.title = opts.title;
  if (opts['no-thinking']) session.events = session.events.filter((e) => e.kind !== 'thinking');
  if (!session.events.length) fail('this session has no messages to replay');

  if (opts.share && opts['no-redact']) fail('--share refuses --no-redact: an unredacted replay should not be uploaded');

  let redactions = null;
  if (!opts['no-redact']) {
    const r = createRedactor({ paths: !opts['keep-paths'] });
    session = r.redact(session);
    redactions = r.counts;
  }

  const stats = computeStats(session, loadPricing(opts.pricing));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...session, stats }, null, 2) + '\n');
    return;
  }

  const out = path.resolve(opts.out || `replay-${String(session.id).replace(/[^\w-]/g, '').slice(0, 12) || 'session'}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderHtml(session, stats, { redactions }));

  const mins = Math.max(1, Math.round(stats.activeMs / 60000));
  const cost = stats.cost != null ? ` · ~$${stats.cost.toFixed(2)}` : '';
  console.log(`${bold('✓')} ${session.agent} · ${session.title || 'Untitled'}`);
  console.log(dim(`  ${session.events.length} events · ${stats.toolCalls} tool calls · ${stats.files.length} files · ${mins} min${cost}`));
  printRedactions(redactions);
  console.log(`  → ${out}`);
  await deliver(out, `${session.title || 'Untitled'} · ${session.agent} replay (agentreplay)`);
}

function printRedactions(redactions) {
  if (!redactions) return console.log('  ⚠ redaction is OFF — check the file before sharing it');
  const total = Object.values(redactions).reduce((a, b) => a + b, 0);
  if (total) console.log(dim(`  redacted: ${Object.entries(redactions).map(([k, v]) => `${v} ${k}`).join(', ')}`));
}

/** Upload with --share, otherwise open the local file. */
async function deliver(out, description) {
  if (opts.share) {
    try {
      const shared = await shareReplay(out, { description });
      console.log(`${bold('✓')} shared as a secret gist (anyone with the link can view it)`);
      console.log(`  ${bold(shared.url)}`);
      console.log(dim(`  delete it any time: ${shared.gistUrl}`));
      if (!opts['no-open'] && !process.env.CI) openFile(shared.url);
    } catch (e) {
      fail(`share failed: ${e.message}`);
    }
    return;
  }
  if (!opts['no-open'] && !process.env.CI) openFile(out);
}

async function race(refs) {
  if (refs.length < 2 || refs.length > MAX_LANES) {
    fail(`race needs 2 to ${MAX_LANES} sessions: agentreplay race <a> <b> [c …]  (each a log file, a --list number, or an agent like claude / codex)`);
  }
  const allSessions = listSessions();
  const used = new Set();
  if (opts.share && opts['no-redact']) fail('--share refuses --no-redact: an unredacted replay should not be uploaded');
  const picked = refs.map((ref) => {
    try {
      const r = resolveRef(ref, { sessions: allSessions, exclude: used });
      used.add(r.file);
      return r;
    } catch (e) {
      return fail(e.message);
    }
  });
  const files = picked.map((p) => p.file);
  if (new Set(files).size !== files.length) fail('the same session is in two lanes; pick different ones');
  let parsed = picked.map((p) => p.parsed || PARSERS[p.agent].parse(p.file));
  for (const s of parsed) {
    if (!s.events.length) fail(`${s.agent} session has no messages to replay`);
    if (opts['no-thinking']) s.events = s.events.filter((e) => e.kind !== 'thinking');
  }
  let redactions = null;
  if (!opts['no-redact']) {
    // One redactor for all lanes, so a secret seen in one lane is scrubbed in every lane.
    const r = createRedactor({ paths: !opts['keep-paths'] });
    parsed = r.redact(parsed);
    redactions = r.counts;
  }
  const pricing = loadPricing(opts.pricing);
  const lanes = parsed.map((s) => buildLane(s, pricing));
  const labels = laneLabels(lanes);
  const slug = refs.map((r) => path.basename(r).replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '').slice(0, 16) || 'session').join('-vs-');
  const out = path.resolve(opts.out || `race-${slug.length > 80 ? `${refs.length}-lanes` : slug}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderRace(lanes, { title: opts.title, redactions }));

  console.log(`${bold('✓')} race · ${labels.join(' vs ')}`);
  const w = Math.max(...labels.map((l) => l.length));
  lanes.forEach((l, i) => {
    const time = l.timed ? `${Math.max(1, Math.round(l.final.ms / 60000))} min` : 'no timestamps';
    const cost = l.final.cost != null ? ` · ~$${l.final.cost.toFixed(2)}` : '';
    console.log(dim(`  ${labels[i].padEnd(w)}  ${time} · ${l.final.toolCalls} tool calls (${l.final.errors} failed) · ${l.final.files} files${cost}  ${l.title ? '· ' + l.title.slice(0, 50) : ''}`));
  });
  printRedactions(redactions);
  console.log(`  → ${out}`);
  await deliver(out, `${labels.join(' vs ')} race (agentreplay)`);
}

function openFile(file) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', file]]
      : process.platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
  } catch {
    /* no browser available — the path is already printed */
  }
}

main().catch((e) => fail(e.message));
