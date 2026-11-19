/**
 * Install the replay skill (an Agent Skills SKILL.md) into every coding agent
 * on this machine. The format is shared; only the folder each agent reads from
 * differs, so we copy the same file into each one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_SRC = fileURLToPath(new URL('../skills/replay/SKILL.md', import.meta.url));
export const SKILL_NAME = 'agentreplayer';

/**
 * Where each agent looks for skills. `home` is the agent's own folder: we only
 * install for agents that are present. `.agents/skills` is the shared location
 * several agents read, so it is always written.
 */
export function targets({ home = os.homedir(), project = null } = {}) {
  const env = process.env;
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  if (project) {
    return [
      { agent: 'Shared (.agents)', dir: path.join(project, '.agents', 'skills'), always: true },
      { agent: 'Claude Code', dir: path.join(project, '.claude', 'skills'), always: true },
      { agent: 'Gemini CLI', dir: path.join(project, '.gemini', 'skills'), when: path.join(project, '.gemini') },
      { agent: 'OpenCode', dir: path.join(project, '.opencode', 'skills'), when: path.join(project, '.opencode') },
      { agent: 'GitHub Copilot', dir: path.join(project, '.github', 'skills'), when: path.join(project, '.github') },
      { agent: 'Cursor', dir: path.join(project, '.cursor', 'skills'), when: path.join(project, '.cursor') },
    ];
  }
  return [
    { agent: 'Shared (~/.agents)', dir: path.join(home, '.agents', 'skills'), always: true },
    { agent: 'Claude Code', dir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'), when: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') },
    { agent: 'Codex', dir: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'), when: env.CODEX_HOME || path.join(home, '.codex') },
    { agent: 'Gemini CLI', dir: path.join(home, '.gemini', 'skills'), when: path.join(home, '.gemini') },
    { agent: 'Qwen Code', dir: path.join(home, '.qwen', 'skills'), when: path.join(home, '.qwen') },
    { agent: 'OpenCode', dir: path.join(xdg, 'opencode', 'skills'), when: path.join(xdg, 'opencode') },
    { agent: 'GitHub Copilot', dir: path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'skills'), when: env.COPILOT_HOME || path.join(home, '.copilot') },
    { agent: 'Cursor', dir: path.join(home, '.cursor', 'skills'), when: path.join(home, '.cursor') },
    { agent: 'Windsurf', dir: path.join(home, '.codeium', 'windsurf', 'skills'), when: path.join(home, '.codeium', 'windsurf') },
    { agent: 'Amp', dir: path.join(xdg, 'amp', 'skills'), when: path.join(xdg, 'amp') },
    { agent: 'Goose', dir: path.join(xdg, 'goose', 'skills'), when: path.join(xdg, 'goose') },
  ];
}

/** The SKILL.md with `name:` matching the folder it's installed into (the spec requires that). */
function skillText() {
  return fs.readFileSync(SKILL_SRC, 'utf8').replace(/^name:\s*.+$/m, `name: ${SKILL_NAME}`);
}

/**
 * @returns {{agent:string, file:string, status:'installed'|'updated'|'unchanged'|'skipped'}[]}
 */
export function installSkill({ home, project, only, force = false } = {}) {
  const text = skillText();
  const results = [];
  for (const t of targets({ home, project })) {
    if (only && !t.agent.toLowerCase().includes(only.toLowerCase())) continue;
    const file = path.join(t.dir, SKILL_NAME, 'SKILL.md');
    if (!t.always && !force && !(t.when && fs.existsSync(t.when))) {
      results.push({ agent: t.agent, file, status: 'skipped' });
      continue;
    }
    let status = 'installed';
    if (fs.existsSync(file)) status = fs.readFileSync(file, 'utf8') === text ? 'unchanged' : 'updated';
    if (status !== 'unchanged') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    // The skill used to be installed as "agentreplay": remove that copy so the agent doesn't see two.
    if (removeOurs(path.join(t.dir, LEGACY_NAME)) && status === 'installed') status = 'updated';
    results.push({ agent: t.agent, file, status });
  }
  return results;
}

/** Skill folder name before the rename to agentreplayer (≤ 0.8.1). */
export const LEGACY_NAME = 'agentreplay';

/** Our SKILL.md: current ones link the repo; older ones name the old repo or scoped npm package. */
const OUR_MARKERS = ['github.com/dorywoof/agentreplayer', 'github.com/dorywoof/agentreplay', '@dorywoof/agentreplay'];
const isOurs = (text) => OUR_MARKERS.some((m) => text.includes(m));

/** Delete a skill folder only if it holds our SKILL.md. Returns true when something was removed. */
function removeOurs(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file) || !isOurs(fs.readFileSync(file, 'utf8'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Remove only folders this tool created (they hold our SKILL.md), under the current and the old name. */
export function uninstallSkill({ home, project } = {}) {
  const results = [];
  for (const t of targets({ home, project })) {
    for (const name of [SKILL_NAME, LEGACY_NAME]) {
      const dir = path.join(t.dir, name);
      if (removeOurs(dir)) results.push({ agent: t.agent, file: path.join(dir, 'SKILL.md'), status: 'removed' });
    }
  }
  return results;
}
