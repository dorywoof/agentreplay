import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));
const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

/** Build the self-contained replay HTML for a parsed + redacted session. */
export function renderHtml(session, stats, { redactions = null } = {}) {
  const data = {
    agent: session.agent,
    title: session.title || 'Untitled session',
    models: session.models,
    branch: session.branch,
    cwd: session.cwd,
    events: session.events.map((e) => ({ ...e, t: e.t ?? null })),
    stats,
    redactions,
    generator: { name: 'agentreplay', version: PKG.version, url: PKG.homepage || null },
  };
  // Escape "<" so session text like "</script>" can't break out of the data block.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');
  const title = escapeHtml(`${data.title} · ${data.agent} replay`);
  return fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace('__TITLE__', () => title)
    .replace('__DATA__', () => json);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
