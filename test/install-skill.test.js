import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, uninstallSkill } from '../src/install-skill.js';

function fakeHome(...agentDirs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-home-'));
  for (const d of agentDirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

test('installs only for agents that exist, plus the shared folder', () => {
  const saved = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME']) delete process.env[k];
  try {
    const home = fakeHome('.codex', '.gemini');
    const res = installSkill({ home });
    const byAgent = Object.fromEntries(res.map((r) => [r.agent, r.status]));
    assert.equal(byAgent['Codex'], 'installed');
    assert.equal(byAgent['Gemini CLI'], 'installed');
    assert.equal(byAgent['Shared (~/.agents)'], 'installed');
    assert.equal(byAgent['Claude Code'], 'skipped');
    const skill = fs.readFileSync(path.join(home, '.codex', 'skills', 'agentreplay', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: agentreplay\n/);
    assert.match(skill, /npx -y agentreplayer@latest/);
    assert.equal(installSkill({ home }).find((r) => r.agent === 'Codex').status, 'unchanged');

    const removed = uninstallSkill({ home });
    assert.equal(removed.length, 3);
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'agentreplay')));
  } finally {
    process.env = saved;
  }
});

test('uninstall leaves a foreign skill with the same name alone', () => {
  const home = fakeHome();
  const dir = path.join(home, '.agents', 'skills', 'agentreplay');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: agentreplay\n---\nsomeone else');
  assert.equal(uninstallSkill({ home }).length, 0);
  assert.ok(fs.existsSync(dir));
});

test('--project installs into the repo', () => {
  const project = fakeHome('.cursor');
  const res = installSkill({ project });
  const installed = res.filter((r) => r.status === 'installed').map((r) => r.agent).sort();
  assert.deepEqual(installed, ['Claude Code', 'Cursor', 'Shared (.agents)']);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', 'agentreplay', 'SKILL.md')));
});
