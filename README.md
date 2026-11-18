<h1 align="center">agentreplay</h1>

<p align="center">
  <b>Turn any AI coding agent session into a shareable, video-like replay.</b><br>
  Claude Code · Codex · Gemini CLI · OpenCode · Cline · Roo · Kilo · Copilot CLI · Qwen · Amp · Aider · any chat log<br>
  One command. One self-contained HTML file. Secrets stripped before you share.
</p>

<p align="center">
  <code>npx @dorywoof/agentreplay</code>
</p>

<p align="center">
  <a href="https://dorywoof.github.io/agentreplay/"><b>▶ Try the live demo</b></a>
</p>

<p align="center">
  <a href="https://dorywoof.github.io/agentreplay/"><img src="docs/demo.gif" alt="agentreplay playing back a Claude Code session: prompts, tool calls, diffs, a failing test and the fix" width="800"></a>
</p>

---

You just watched an AI agent build a feature in 6 minutes. Now you want to show someone — but all you have is a 4 MB JSONL file nobody can read.

**agentreplay** turns that log into a page that *plays back* the session: prompts, reasoning, every tool call, every diff, with a scrubbable timeline and a summary card that says what it did, how long it took and what it cost.

## Features

- ▶️ **Plays like a video.** Events appear in order with condensed timing; scrub, skip, pause, or change speed. Edits, errors and prompts are marked on the timeline.
- 🤝 **Works with (almost) every agent.** Built-in support for 11 coding agents, plus a universal parser that understands Anthropic, OpenAI and Gemini message formats. Point it at any JSON or JSONL chat log and it will try to replay it.
- 💸 **Cost and token panel.** Input, output and cache tokens. Shows the real cost when the agent records it (Cline, Roo, OpenCode), otherwise an estimate at list prices.
- 🔒 **Safe to share by default.** API keys, tokens, JWTs, private keys, passwords in env assignments, e-mail addresses and your home directory are redacted *before* the HTML is written. The footer says what was removed.
- 📝 **Real diffs.** Edits are shown as red and green diffs with a per-file `+/-` summary: Claude's `Edit`/`Write`, Codex `apply_patch`, Cline/Roo/Aider SEARCH/REPLACE blocks, OpenCode and Gemini edit tools.
- 📦 **One file, zero dependencies.** The output is one HTML file that works offline. Host it anywhere: GitHub Pages, a gist, Slack, e-mail.
- 🌍 **Speaks the viewer's language.** The page follows the browser language (English, Türkçe, Español, Deutsch, Français, Português, Italiano, Русский, 日本語, 中文, 한국어). Add `?lang=xx` to force one.
- 🧮 **Honest token numbers.** Agents re-send the whole conversation on every request, so summed tokens balloon. The replay leads with the largest single prompt and explains the total, including how much came from cache.
- 🌗 Light and dark themes, works on phones, and keyboard shortcuts (`space`, `←` `→`, `Home`, `End`).

## Quick start

```bash
npx @dorywoof/agentreplay            # replays your most recent session and opens it
```

```bash
npx @dorywoof/agentreplay --list     # pick from recent sessions of every agent
npx @dorywoof/agentreplay --pick 3
npx @dorywoof/agentreplay path/to/session.jsonl -o my-replay.html
npx @dorywoof/agentreplay --agents   # which agents were found on this machine
```

Requires Node 18+. Nothing is uploaded anywhere: everything happens on your machine.

### As a Claude Code plugin

Replay the session you're in without leaving Claude Code:

```
/plugin install agentreplay --marketplace dorywoof/agentreplay
```

On older Claude Code versions, use two steps instead:

```
/plugin marketplace add dorywoof/agentreplay
/plugin install agentreplay@agentreplay
```

Then type `/agentreplay:replay`, or just ask *"make a replay of this session"*. Claude runs the CLI for you, writes the HTML next to your project and tells you what was redacted. Arguments pass through, for example `/agentreplay:replay --list`.

### As a skill in Codex, Gemini CLI, OpenCode, Copilot, Cursor…

Most agents now read the open [Agent Skills](https://agentskills.io) format (`SKILL.md`). One command installs the replay skill into every agent it finds on your machine:

```bash
npx @dorywoof/agentreplay install-skill
```

| Agent | Installed to |
|---|---|
| Shared folder several agents read | `~/.agents/skills/agentreplay/` (always) |
| Claude Code | `~/.claude/skills/agentreplay/` |
| Codex | `~/.codex/skills/agentreplay/` |
| Gemini CLI | `~/.gemini/skills/agentreplay/` |
| Qwen Code | `~/.qwen/skills/agentreplay/` |
| OpenCode | `~/.config/opencode/skills/agentreplay/` |
| GitHub Copilot | `~/.copilot/skills/agentreplay/` |
| Cursor | `~/.cursor/skills/agentreplay/` |
| Windsurf, Amp, Goose | their own `skills/` folders |

Folders are only written for agents that are installed (`--force` writes all of them). `--agent codex` limits it to one agent, `--project` installs into the current repo instead (`.agents/skills`, `.claude/skills`, …) so your whole team gets it, and `uninstall-skill` removes it again. Restart the agent afterwards, then ask it to *"make a replay of this session"*.

> Skill folder locations differ between agents and versions. If your agent doesn't pick the skill up, copy [`skills/replay/SKILL.md`](skills/replay/SKILL.md) into the folder its docs name.

### Where sessions live

Sessions are found automatically. You can also pass any file directly.

| Agent | `--agent` | Where it looks |
|---|---|---|
| Claude Code | `claude` | `~/.claude/projects/*/*.jsonl` |
| Codex | `codex` | `~/.codex/sessions/**/rollout-*.jsonl` |
| Gemini CLI | `gemini` | `~/.gemini/tmp/*/chats/*.json(l)` |
| Qwen Code | `qwen` | `~/.qwen/projects/*/chats/*.jsonl` |
| OpenCode | `opencode` | `~/.local/share/opencode/`: `storage/` JSON, `opencode.db`, or an `opencode export` file |
| Cline | `cline` | VS Code / Cursor / Windsurf globalStorage `saoudrizwan.claude-dev/tasks/*`, `~/.cline/data/tasks/*` |
| Roo Code | `roo` | globalStorage `rooveterinaryinc.roo-cline/tasks/*` |
| Kilo Code | `kilo` | globalStorage `kilocode.kilo-code/tasks/*` |
| GitHub Copilot CLI | `copilot` | `~/.copilot/session-state/**/*.jsonl` |
| Amp | `amp` | `~/.local/share/amp/threads/*.json` |
| Aider | `aider` | `.aider.chat.history.md` in the current folder |
| Anything else | `generic` | Pass the file: Anthropic / OpenAI / Gemini-style messages in JSON or JSONL |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_DIR`, `QWEN_DATA_DIR`, `AMP_DATA_DIR`, `COPILOT_HOME` and `XDG_DATA_HOME` are respected. Reading `opencode.db` needs Node 22.5+ (built-in SQLite).

> Only Claude Code and Codex have been tested against real logs so far. The others are built from their documented formats and tested with fixtures. If a session from your agent doesn't replay correctly, please [open an issue](https://github.com/dorywoof/agentreplay/issues) with a redacted sample.

## Options

```
-o, --out <file>      output HTML path (default: ./replay-<id>.html)
-a, --agent <name>    only one agent (see the table above)
-s, --session <id>    replay the session whose id / file name matches
-t, --title <text>    override the replay title
    --no-thinking     hide thinking / reasoning blocks
    --no-redact       keep secrets, e-mails and home paths (not for sharing!)
    --keep-paths      redact secrets but keep file paths as-is
    --pricing <file>  JSON with custom $/1M token prices per model
    --json            print the normalized session JSON instead of HTML
    --no-open         don't open the replay in a browser
```

**URL tricks:** add `#e42` to open a replay at event 42, `?static` to show the whole session at once with no animation, or `?lang=de` to pick the interface language.

## Sharing a replay

The output is a static file, so any of these work:

- **GitHub Pages:** commit `replay.html` to a `gh-pages` branch.
- **Gist:** upload it, then open it through a gist-preview service.
- **Netlify / Vercel drop:** drag and drop the file.

> ⚠️ Redaction catches common secret formats, but it can't know everything that is private to you. Skim the replay before posting it publicly.

## About the cost estimate

When the agent records what a session cost (Cline, Roo, Kilo, OpenCode), that number is shown. Otherwise cost is estimated from public per-token API list prices (including cache reads and writes) for the Claude models it knows about. If you're on a subscription plan, it shows what the session *would* cost on the API. For models it has no price for, only token counts are shown. You can supply your own prices:

```json
{ "gpt-6.1": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }
```

```bash
npx @dorywoof/agentreplay --pricing prices.json
```

## Roadmap

- [ ] Cursor and Windsurf built-in chat (stored in proprietary SQLite blobs)
- [ ] Goose, Crush, Droid and Kiro sessions
- [ ] Export to GIF / MP4 for social posts
- [ ] Subagent (sidechain) lanes
- [ ] `agentreplay publish`: one-command upload to a gist
- [ ] Combine several sessions into one replay

Ideas and PRs are welcome. Adding a new agent usually means a few lines in `src/parsers/agents.js` that find its files and hand them to the universal parser.

## Development

```bash
npm test                     # node:test, no dependencies
node scripts/make-demo.js    # regenerate examples/demo-session.jsonl
npm run demo                 # render examples/demo.html
```

## License

MIT
