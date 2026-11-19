/**
 * `--share`: upload a replay as a secret GitHub Gist and return a link to the
 * hosted viewer, which renders it in a sandboxed iframe.
 *
 * Auth, in order: the GitHub CLI (`gh`, already logged in), then a
 * GITHUB_TOKEN / GH_TOKEN with the "gist" scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const VIEWER = 'https://dorywoof.github.io/agentreplay/view.html';
const GIST_ID = /^[0-9a-f]{20,40}$/i;

export function viewerUrl(gistId) {
  return `${VIEWER}#${gistId}`;
}

/** Gist id from `gh gist create` output (https://gist.github.com/<user>/<id>). */
export function gistIdFrom(text) {
  const m = String(text).match(/gist\.github\.com\/(?:[\w-]+\/)?([0-9a-f]{20,40})\b/i);
  return m ? m[1] : null;
}

function viaGh(file, description) {
  const probe = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', shell: false });
  if (probe.error || probe.status !== 0) return { skipped: probe.error ? 'gh not installed' : 'gh not logged in' };
  const r = spawnSync('gh', ['gist', 'create', file, '--desc', description], { encoding: 'utf8', shell: false, maxBuffer: 1 << 20 });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || 'gh gist create failed').trim() };
  const id = gistIdFrom(r.stdout);
  return id ? { id } : { error: `unexpected gh output: ${r.stdout.trim()}` };
}

async function viaToken(file, description, token) {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'agentreplay',
    },
    body: JSON.stringify({ description, public: false, files: { [path.basename(file)]: { content: fs.readFileSync(file, 'utf8') } } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: `GitHub API ${res.status}: ${body.message || res.statusText}` };
  return GIST_ID.test(body.id || '') ? { id: body.id } : { error: 'GitHub API returned no gist id' };
}

/** @returns {Promise<{ id: string, gistUrl: string, url: string }>} */
export async function shareReplay(file, { description = 'agentreplay', env = process.env, useGh = true } = {}) {
  const gh = useGh ? viaGh(file, description) : { skipped: 'gh disabled' };
  let result = gh;
  if (gh.skipped) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!token) {
      throw new Error(
        `can't upload: ${gh.skipped} and no GITHUB_TOKEN is set.\n` +
          '  Either run `gh auth login` once, or set GITHUB_TOKEN to a token with the "gist" scope.',
      );
    }
    result = await viaToken(file, description, token);
  }
  if (result.error) throw new Error(result.error);
  return { id: result.id, gistUrl: `https://gist.github.com/${result.id}`, url: viewerUrl(result.id) };
}
