import os from 'node:os';
import path from 'node:path';

/**
 * Patterns for secrets that should never end up in a shared replay.
 * Order matters: specific token formats first, generic KEY=value last.
 */
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['Google key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['Stripe key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer token', /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g],
  ['URL credentials', /(\w+:\/\/[^\s:/@]+:)[^\s@/]+(@)/g],
  // Env-style assignments only (UPPER_SNAKE names, case-sensitive) so ordinary
  // code like `local token = entry.Token` is left alone. Value must contain a digit.
  [
    'assigned secret',
    /\b([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)(?=[A-Za-z0-9_\-./+=]*\d)[A-Za-z0-9_\-./+=]{8,}/g,
  ],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function createRedactor({ paths = true, emails = true } = {}) {
  const counts = {};
  const home = os.homedir();
  const user = path.basename(home);
  const homeRe = paths ? homePattern(home) : null;

  function bump(kind) {
    counts[kind] = (counts[kind] || 0) + 1;
  }

  // Every secret value found anywhere. A key that shows up once as
  // "API_KEY=abc…" is often echoed bare later (tool output, logs, an `echo`),
  // where no pattern would recognise it — so known values are scrubbed everywhere.
  const known = new Set();
  const MIN_ECHO_LEN = 8; // shorter values are too likely to be ordinary text

  /** The secret part of a pattern match, without kept prefixes like "API_KEY=" or "Bearer ". */
  function secretPart(m) {
    const groups = m.slice(1, -2).filter((g) => typeof g === 'string');
    let value = m[0];
    if (groups.length >= 1 && value.startsWith(groups[0])) value = value.slice(groups[0].length);
    if (groups.length === 2 && value.endsWith(groups[1])) value = value.slice(0, value.length - groups[1].length);
    return { value, groups };
  }

  function collect(s) {
    for (const [, re] of SECRET_PATTERNS) {
      for (const m of s.matchAll(re)) {
        const { value } = secretPart([...m, m.index, s]);
        if (value.length >= MIN_ECHO_LEN) known.add(value);
      }
    }
  }

  function redactString(s) {
    for (const [kind, re] of SECRET_PATTERNS) {
      s = s.replace(re, (...m) => {
        bump(kind);
        // keep capture-group prefixes/suffixes (e.g. "API_KEY=" or "Bearer ")
        const { groups } = secretPart(m);
        if (groups.length === 2) return `${groups[0]}[REDACTED]${groups[1]}`;
        if (groups.length === 1) return `${groups[0]}[REDACTED]`;
        return `[REDACTED ${kind}]`;
      });
    }
    // Second line of defence: bare copies of secrets seen elsewhere in the session.
    for (const value of knownByLength) {
      if (s.includes(value)) {
        const parts = s.split(value);
        for (let i = 1; i < parts.length; i++) bump('echoed secret');
        s = parts.join('[REDACTED]');
      }
    }
    if (emails) {
      s = s.replace(EMAIL, (m) => {
        if (/noreply|example\.(com|org)/i.test(m)) return m;
        bump('email');
        return '[email]';
      });
    }
    if (homeRe) {
      s = s.replace(homeRe, () => {
        bump('home path');
        return '~';
      });
    }
    // Claude Code project folder names encode the home path with dashes.
    if (paths && user && user.length > 2) {
      s = s.replace(new RegExp(`\\b[A-Za-z]--Users-${escapeRe(user)}\\b`, 'g'), '~');
    }
    return s;
  }

  function walk(v, fn) {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, fn));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, fn);
      return out;
    }
    return v;
  }

  let knownByLength = [];
  function redact(v) {
    // Pass 1: learn every secret value in the whole session. Pass 2: scrub.
    walk(v, (s) => (collect(s), s));
    knownByLength = [...known].sort((a, b) => b.length - a.length);
    return walk(v, redactString);
  }

  return { redact, counts };
}

/**
 * The home folder in every spelling a log can hold it: / or \ separators,
 * JSON-escaped backslashes (\\ or \\\\ when JSON is nested in JSON), Git Bash
 * style /c/Users/…, and any letter case on Windows.
 */
export function homePattern(home) {
  const sep = '(?:\\\\+|/+)';
  const parts = home.split(/[\\/]+/).filter(Boolean);
  let prefix = '';
  if (/^[A-Za-z]:$/.test(parts[0] || '')) {
    const d = parts.shift()[0];
    prefix = `(?:${d}:|/${d})${sep}`;
  } else {
    prefix = sep;
  }
  if (!parts.length || parts.join('').length < 3) return null;
  const body = parts.map(escapeRe).join(sep);
  // Windows paths are case-insensitive, so logs often hold c:\users\… too.
  return new RegExp(`${prefix}${body}(?![A-Za-z0-9_])`, prefix !== sep ? 'gi' : 'g');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
