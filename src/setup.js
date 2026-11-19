/**
 * `agentreplayer setup`: wire the status line and hooks into Claude Code's
 * ~/.claude/settings.json. Only entries that run agentreplayer are touched;
 * everything else in the file (other hooks, a foreign status line) is left alone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PARTS = ['statusline', 'guard', 'summary'];

export function settingsPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

/**
 * Where the status line we wrap is kept, next to the settings file it came from,
 * so `--remove` can put it back exactly (and each CLAUDE_CONFIG_DIR keeps its own).
 */
export const wrapFile = (settingsFile = settingsPath()) => path.join(path.dirname(settingsFile), 'agentreplayer-statusline.json');

export function readWrapped(file = wrapFile()) {
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    return w && typeof w.command === 'string' ? w : null;
  } catch {
    return null;
  }
}

/** A shell command that runs this CLI with absolute paths (forward slashes work in cmd, PowerShell and bash). */
export function commandFor(nodePath, binPath, args) {
  const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
  return `${q(nodePath)} ${q(binPath)} ${args}`;
}

const isOurs = (cmd, args) => typeof cmd === 'string' && /agentreplayer/i.test(cmd) && (cmd.trimEnd().endsWith(args) || cmd.trimEnd().endsWith(`${args} --wrap`));

const HOOKS = {
  guard: { event: 'UserPromptSubmit', args: 'hook prompt', timeout: 10 },
  summary: { event: 'SessionEnd', args: 'hook session-end', timeout: 30 },
};

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it first, nothing was changed`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.agentreplayer-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** Remove our handler from one hook event; drops groups/events that end up empty. */
function dropHook(settings, event, args) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  let removed = false;
  const kept = [];
  for (const g of groups) {
    const hooks = (g.hooks || []).filter((h) => {
      const ours = isOurs(h.command, args);
      removed ||= ours;
      return !ours;
    });
    if (hooks.length) kept.push({ ...g, hooks });
  }
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

/**
 * @returns {{ part: string, status: 'added'|'updated'|'kept'|'skipped'|'removed'|'absent', note?: string }[]}
 */
export function setup({ file = settingsPath(), nodePath = process.execPath, binPath, parts = PARTS, force = false, refreshInterval = 30, wrapPath = wrapFile(file) } = {}) {
  const settings = readSettings(file);
  const results = [];

  if (parts.includes('statusline')) {
    const cur = settings.statusLine;
    const foreign = cur && !isOurs(cur.command, 'statusline');
    // Somebody else's status line: keep it and add ours after it (--force replaces it instead).
    const wrapping = (foreign && !force) || (!foreign && cur?.command?.endsWith('--wrap') && !!readWrapped(wrapPath));
    if (foreign && !force) {
      fs.mkdirSync(path.dirname(wrapPath), { recursive: true });
      fs.writeFileSync(wrapPath, JSON.stringify(cur, null, 2));
    }
    const base = wrapping ? readWrapped(wrapPath) : null;
    const next = {
      ...(base?.padding != null ? { padding: base.padding } : {}),
      type: 'command',
      command: commandFor(nodePath, binPath, wrapping ? 'statusline --wrap' : 'statusline'),
      refreshInterval: base?.refreshInterval ? Math.min(base.refreshInterval, refreshInterval) : refreshInterval,
    };
    const same = cur && JSON.stringify(cur) === JSON.stringify(next);
    settings.statusLine = next;
    results.push({
      part: 'statusline',
      status: same ? 'kept' : cur && !foreign ? 'updated' : 'added',
      note: foreign && !force ? 'kept your status line and added ours after it' : foreign ? 'replaced your status line (--force)' : undefined,
    });
  }

  for (const part of ['guard', 'summary']) {
    if (!parts.includes(part)) continue;
    const { event, args, timeout } = HOOKS[part];
    const had = dropHook(settings, event, args);
    settings.hooks ||= {};
    (settings.hooks[event] ||= []).push({ hooks: [{ type: 'command', command: commandFor(nodePath, binPath, args), timeout }] });
    results.push({ part, status: had ? 'updated' : 'added' });
  }

  writeSettings(file, settings);
  return results;
}

export function unsetup({ file = settingsPath(), wrapPath = wrapFile(file) } = {}) {
  if (!fs.existsSync(file)) return PARTS.map((part) => ({ part, status: 'absent' }));
  const settings = readSettings(file);
  const results = [];
  if (settings.statusLine && isOurs(settings.statusLine.command, 'statusline')) {
    const original = settings.statusLine.command.trimEnd().endsWith('--wrap') ? readWrapped(wrapPath) : null;
    if (original) settings.statusLine = original;
    else delete settings.statusLine;
    try {
      fs.rmSync(wrapPath, { force: true });
    } catch {
      /* fine */
    }
    results.push({ part: 'statusline', status: 'removed', note: original ? 'your own status line is back' : undefined });
  } else results.push({ part: 'statusline', status: 'absent' });
  for (const part of ['guard', 'summary']) {
    const { event, args } = HOOKS[part];
    results.push({ part, status: dropHook(settings, event, args) ? 'removed' : 'absent' });
  }
  writeSettings(file, settings);
  return results;
}
