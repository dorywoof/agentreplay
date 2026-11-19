import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gistIdFrom, viewerUrl, shareReplay } from '../src/share.js';

const ID = 'aa11bb22cc33dd44ee55ff66aa77bb88';

test('reads the gist id from gh output and builds the viewer link', () => {
  assert.equal(gistIdFrom(`- Creating gist replay.html\n✓ Created secret gist replay.html\nhttps://gist.github.com/someone/${ID}\n`), ID);
  assert.equal(gistIdFrom('nothing here'), null);
  assert.equal(viewerUrl(ID), `https://dorywoof.github.io/agentreplayer/view.html#${ID}`);
});

test('uploads with a token as a secret gist', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-share-')), 'replay-x.html');
  fs.writeFileSync(file, '<html>hi</html>');
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: ID }), { status: 201 });
  });
  const r = await shareReplay(file, { description: 'demo', env: { GITHUB_TOKEN: 't0k' }, useGh: false });
  assert.equal(sent.url, 'https://api.github.com/gists');
  assert.equal(sent.init.headers.Authorization, 'Bearer t0k');
  assert.equal(sent.body.public, false);
  assert.equal(sent.body.files['replay-x.html'].content, '<html>hi</html>');
  assert.equal(r.url, viewerUrl(ID));
});

test('explains how to log in when there is no way to upload', async () => {
  await assert.rejects(shareReplay('x.html', { env: {}, useGh: false }), /gh auth login/);
});

test('surfaces GitHub API errors', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-share-')), 'r.html');
  fs.writeFileSync(file, 'x');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
  await assert.rejects(shareReplay(file, { env: { GH_TOKEN: 'bad' }, useGh: false }), /401: Bad credentials/);
});

test('CLI loads and --share refuses an unredacted upload', async () => {
  const { spawnSync } = await import('node:child_process');
  const bin = fileURLToPath(new URL('../bin/agentreplayer.js', import.meta.url));
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--share/);
  const demo = fileURLToPath(new URL('../examples/demo-session.jsonl', import.meta.url));
  const r = spawnSync(process.execPath, [bin, demo, '--share', '--no-redact', '--no-open'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refuses --no-redact/);
});
