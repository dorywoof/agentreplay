/**
 * "Today" for the status line. Adding up a day of sessions takes a second or
 * two, and the status line must answer in milliseconds, so the number lives in
 * a small cache file that a detached background process refreshes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collectSessions, analyze } from './insights.js';

export const FRESH_MS = 2 * 60_000; // recompute at most every 2 minutes
const LOCK_MS = 60_000; // one refresher at a time
const DAY = 86_400_000;

export const cacheDir = () => path.join(os.homedir(), '.agentreplayer');
const cacheFile = (dir) => path.join(dir, 'today.json');
const lockFile = (dir) => path.join(dir, 'today.lock');

export const localDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA');
export function midnight(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The cached total for today, or null. Never blocks on a refresh. */
export function readToday({ dir = cacheDir(), now = Date.now() } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8'));
    if (c.day !== localDay(now)) return { stale: true, value: null };
    return { stale: now - c.at > FRESH_MS, value: c };
  } catch {
    return { stale: true, value: null };
  }
}

/** Start a detached refresh unless one ran in the last minute. */
export function kickRefresh(binPath, { dir = cacheDir(), now = Date.now() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (now - Number(fs.readFileSync(lockFile(dir), 'utf8')) < LOCK_MS) return false;
    } catch {
      /* no lock yet */
    }
    fs.writeFileSync(lockFile(dir), String(now));
    spawn(process.execPath, [binPath, 'statusline', '--refresh-today'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Add up every agent's requests since local midnight and write the cache. */
export function refreshToday(pricing, { dir = cacheDir(), now = Date.now() } = {}) {
  const since = midnight(now);
  const data = collectSessions({ days: (now - since) / DAY || 1 / 1440, now });
  const R = analyze(data, pricing);
  const value = { day: localDay(now), at: now, cost: R.total.cost, unpricedTokens: R.total.unpricedTokens, tokens: R.total.tokens, sessions: R.sessions };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFile(dir), JSON.stringify(value));
  try {
    fs.rmSync(lockFile(dir), { force: true });
  } catch {
    /* fine */
  }
  return value;
}
