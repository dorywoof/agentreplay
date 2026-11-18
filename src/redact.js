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
  const homeVariants = paths
    ? [...new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), toPosixDrive(home)])].filter(
        (h) => h && h.length > 3,
      )
    : [];

  function bump(kind) {
    counts[kind] = (counts[kind] || 0) + 1;
  }

  function redactString(s) {
    for (const [kind, re] of SECRET_PATTERNS) {
      s = s.replace(re, (...m) => {
        bump(kind);
        // keep capture-group prefixes/suffixes (e.g. "API_KEY=" or "Bearer ")
        const groups = m.slice(1, -2).filter((g) => typeof g === 'string');
        if (groups.length === 2) return `${groups[0]}[REDACTED]${groups[1]}`;
        if (groups.length === 1) return `${groups[0]}[REDACTED]`;
        return `[REDACTED ${kind}]`;
      });
    }
    if (emails) {
      s = s.replace(EMAIL, (m) => {
        if (/noreply|example\.(com|org)/i.test(m)) return m;
        bump('email');
        return '[email]';
      });
    }
    for (const h of homeVariants) {
      if (s.includes(h)) {
        bump('home path');
        s = s.split(h).join('~');
      }
    }
    // Claude Code project folder names encode the home path with dashes.
    if (paths && user && user.length > 2) {
      s = s.replace(new RegExp(`\\b[A-Za-z]--Users-${escapeRe(user)}\\b`, 'g'), '~');
    }
    return s;
  }

  function walk(v) {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  }

  return { redact: walk, counts };
}

function toPosixDrive(p) {
  const m = p.match(/^([A-Za-z]):\\(.*)$/);
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
