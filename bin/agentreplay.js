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

const HELP = `
agentreplay — turn an AI coding session into a shareable replay

Usage
  agentreplay                    replay your most recent session
  agentreplay <session.jsonl>    replay a specific log file
  agentreplay --list             list recent sessions
  agentreplay --pick 3           replay #3 from --list
  agentreplay --agents           show supported agents and what was found

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
    'no-thinking': { type: 'boolean' },
    'no-redact': { type: 'boolean' },
    'keep-paths': { type: 'boolean' },
    pricing: { type: 'string' },
    json: { type: 'boolean' },
    'no-open': { type: 'boolean' },
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

function main() {
  if (opts.help) return console.log(HELP);
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

  let file, agent;
  if (positionals[0]) {
    file = path.resolve(positionals[0]);
    if (!fs.existsSync(file.split('#')[0])) fail(`file not found: ${file}`);
    agent = opts.agent || detectAgent(file);
    if (!agent) fail('could not find a conversation in this file. Run agentreplay --agents to see supported formats.');
  } else {
    const sessions = listSessions({ agent: opts.agent });
    if (!sessions.length) fail('no agent sessions found on this machine. Pass a log file path instead.');
    const idx = opts.pick ? Number(opts.pick) - 1 : 0;
    if (!sessions[idx]) fail(`no session #${opts.pick} — run with --list to see what's available`);
    ({ file, agent } = sessions[idx]);
  }

  let session = PARSERS[agent].parse(file);
  if (opts.title) session.title = opts.title;
  if (opts['no-thinking']) session.events = session.events.filter((e) => e.kind !== 'thinking');
  if (!session.events.length) fail('this session has no messages to replay');

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

  const out = path.resolve(opts.out || `replay-${String(session.id).replace(/[^w-]/g, '').slice(0, 12) || 'session'}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderHtml(session, stats, { redactions }));

  const mins = Math.max(1, Math.round(stats.activeMs / 60000));
  const cost = stats.cost != null ? ` · ~$${stats.cost.toFixed(2)}` : '';
  console.log(`${bold('✓')} ${session.agent} · ${session.title || 'Untitled'}`);
  console.log(dim(`  ${session.events.length} events · ${stats.toolCalls} tool calls · ${stats.files.length} files · ${mins} min${cost}`));
  if (redactions) {
    const total = Object.values(redactions).reduce((a, b) => a + b, 0);
    if (total) console.log(dim(`  redacted: ${Object.entries(redactions).map(([k, v]) => `${v} ${k}`).join(', ')}`));
  } else {
    console.log('  ⚠ redaction is OFF — check the file before sharing it');
  }
  console.log(`  → ${out}`);

  if (!opts['no-open'] && !process.env.CI) openFile(out);
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

main();
