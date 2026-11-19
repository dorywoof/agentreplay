import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (name) => fileURLToPath(new URL(name, import.meta.url));
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
const PKG = JSON.parse(fs.readFileSync(file('../package.json'), 'utf8'));

export const generator = () => ({ name: 'agentreplay', version: PKG.version, url: PKG.homepage || null });

/** JSON that is safe inside <script>: "</script>" in session text can't break out of the data block. */
export function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');
}

/** Fill a page template (shared theme CSS, title, data). */
export function fillTemplate(name, title, data) {
  return fs
    .readFileSync(file(name), 'utf8')
    .replace('/*__CSS__*/', () => fs.readFileSync(file('./theme.css'), 'utf8'))
    .replace('__TITLE__', () => escapeHtml(title))
    .replace('__DATA__', () => safeJson(data));
}

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
    generator: generator(),
  };
  return fillTemplate('./template.html', `${data.title} · ${data.agent} replay`, data);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
