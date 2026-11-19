<h1 align="center">agentreplayer</h1>

<p align="center">
  <b>Turn any AI coding agent session into a shareable, video-like replay.</b><br>
  Claude Code · Codex · Gemini CLI · OpenCode · Cline · Roo · Kilo · Copilot CLI · Qwen · Amp · Aider · any chat log<br>
  One command. One self-contained HTML file. Secrets stripped before you share.
</p>

<p align="center">
  <code>npx agentreplayer</code>
</p>

<p align="center">
  <a href="https://dorywoof.github.io/agentreplayer/"><b>▶ Try the live demo</b></a>
</p>

<p align="center">
  <a href="https://dorywoof.github.io/agentreplayer/"><img src="docs/demo.gif" alt="agentreplayer playing back a Claude Code session: prompts, tool calls, diffs, a failing test and the fix" width="800"></a>
</p>

---

You just watched an AI agent build a feature in 6 minutes. Now you want to show someone — but all you have is a 4 MB JSONL file nobody can read.

**agentreplayer** turns that log into a page that *plays back* the session: prompts, reasoning, every tool call, every diff, with a scrubbable timeline and a summary card that says what it did, how long it took and what it cost.

## Features

- 📟 **Every day in Claude Code.** `agentreplayer setup` adds a status line (session cost, context size, cost per message), a one-time warning before a message re-processes a cold cache, and a summary + saved replay when a session ends. [More ↓](#every-day-in-claude-code)
- 🏁 **`race`: up to six agents side by side.** Play Claude Code, Codex, Gemini CLI… sessions in sync on one clock, with live counters and finishing places. [More ↓](#race-up-to-six-agents-one-clock)
- 🔗 **`--share`: one-command link.** Uploads the redacted replay as a secret gist and prints a link that plays it.
- 🔎 **`insights`: see where your tokens went.** One command scans a week of sessions from every agent and finds retry loops, giant tool outputs that every later request re-read, and cache misses, then says what to change. [More ↓](#insights-where-did-your-tokens-go)

- ▶️ **Plays like a video.** Events appear in order with condensed timing; scrub, skip, pause, or change speed. Edits, errors and prompts are marked on the timeline.
- 🤝 **Works with (almost) every agent.** Built-in support for 11 coding agents, plus a universal parser that understands Anthropic, OpenAI and Gemini message formats. Point it at any JSON or JSONL chat log and it will try to replay it.
- 💸 **Cost and token panel.** Input, output and cache tokens. Shows the real cost when the agent records it (Cline, Roo, OpenCode), otherwise an estimate at list prices.
- 🔒 **Safe to share by default.** API keys, tokens, JWTs, private keys, passwords in env assignments, e-mail addresses and your home directory are redacted *before* the HTML is written. Any secret found once is also scrubbed wherever it's echoed later in the session (tool output, logs, `echo $VAR`), even without its `KEY=` prefix. The footer says what was removed.
- 📝 **Real diffs.** Edits are shown as red and green diffs with a per-file `+/-` summary: Claude's `Edit`/`Write`, Codex `apply_patch`, Cline/Roo/Aider SEARCH/REPLACE blocks, OpenCode and Gemini edit tools.
- 📦 **One file, zero dependencies.** The output is one HTML file that works offline. Host it anywhere: GitHub Pages, a gist, Slack, e-mail.
- 🌍 **Speaks the viewer's language.** The page follows the browser language (English, Türkçe, Español, Deutsch, Français, Português, Italiano, Русский, 日本語, 中文, 한국어). Add `?lang=xx` to force one.
- 🧮 **Honest token numbers.** Agents re-send the whole conversation on every request, so summed tokens balloon. The replay leads with the largest single prompt and explains the total, including how much came from cache.
- 🌗 Light and dark themes, works on phones, and keyboard shortcuts (`space`, `←` `→`, `Home`, `End`).

## Quick start

```bash
npx agentreplayer            # replays your most recent session and opens it
```

```bash
npx agentreplayer --list     # pick from recent sessions of every agent
npx agentreplayer --pick 3
npx agentreplayer path/to/session.jsonl -o my-replay.html
npx agentreplayer --agents   # which agents were found on this machine
```

Requires Node 18+. Nothing is uploaded anywhere: everything happens on your machine.

## Every day in Claude Code

```bash
npm install -g agentreplayer
agentreplayer setup            # undo with: agentreplayer setup --remove
```

Restart Claude Code and you get three things, all running locally:

- **A status line** with what the session cost, today's total across every agent, the context size, and what each message costs to send. On a Pro/Max subscription it leads with your 5-hour and weekly limits instead, since that's what you actually spend. Past 150k tokens it suggests starting fresh, because every message re-sends the whole conversation.
  `$3.20 · today ~$41 · 162k ctx · each msg ~$0.03 · long session: /clear saves money`
  `5h 76% (resets 1h23m) · 7d 31% · ~$20 API · 162k ctx · long session: /clear saves limit`
- **A cold-cache guard.** When you come back from a break, the prompt cache has expired, and the conversation is big, your next message would re-process all of it at full price. agentreplayer stops that message once and tells you what it would cost. Send it again to go ahead, or `/clear` to continue for less.
- **A summary when a session ends**, plus a replay of it saved to `~/.agentreplayer/replays/`:
  `agentreplayer: 42 min · 118 tool calls · 6 files +412 −80 · ~$6.10`

**Already have a status line?** It stays. `setup` keeps your command and adds agentreplayer's segment after it: on the same row when there's room, otherwise on a row below. `setup --remove` puts your original back exactly. Use `--force` to replace it instead.

The status line is plain text and colour, with no emoji or Nerd Font glyphs, so it lines up in every terminal. When the terminal is narrow it drops the least important pieces first; the context size always stays. Today's total is computed in the background and cached, so the line never waits for it.

`setup` only adds its own entries to `~/.claude/settings.json`. It keeps your other hooks and saves a backup first. Pick parts with `--only statusline,guard,summary`.

## Race: up to six agents, one clock

```bash
npx agentreplayer race claude codex          # newest session of each, side by side
npx agentreplayer race claude codex gemini   # three agents
npx agentreplayer race claude claude         # your two newest Claude Code sessions
npx agentreplayer race 1 3 4                 # sessions from --list
npx agentreplayer race a.jsonl b.jsonl --share
```

Give the same task to 2–6 agents (or models), then play all the sessions in sync. Each lane shows a live clock, tool calls, failures, files, lines changed, tokens and cost, and lanes get 1st / 2nd / 3rd… as they finish (lanes within 3% of each other share a place). Two lanes from the same agent are told apart by model, or numbered. Clocks show working time: pauses longer than 2 minutes count as 2 minutes in every lane, so a coffee break doesn't decide the race. `?at=754` opens the page at 12:34.

## Insights: where did your tokens go?

```bash
npx agentreplayer insights            # last 7 days, every agent
npx agentreplayer insights --days 30 --agent claude
```

Reads every session on your machine (Claude Code including subagents, Codex, Gemini CLI, OpenCode, Cline…) and tells you:

- **Spend** by project, agent and day, at API list prices (tokens only for models without a known price). Agents get the same yardsticks side by side: tokens per session, per tool call, cache hit rate, failed calls.
- **Retry loops.** The same command failing 3+ times in a row, and what was spent while stuck.
- **Huge tool outputs.** A 10k-token `cat` isn't paid once. Every later request re-reads it until the context is reset, so it shows the real carried cost.
- **Cache misses** in the middle of a conversation, split by cause: a 5+ minute pause, a model switch, or something else.
- **What to do**: a few concrete changes, each backed by the numbers above. Advice only appears when the data supports it.

Resumed and forked sessions copy earlier history into a new log; each request is counted once. `--json` gives the raw report.

### As a Claude Code plugin

Replay the session you're in without leaving Claude Code:

```
/plugin install agentreplayer --marketplace dorywoof/agentreplayer
```

On older Claude Code versions, use two steps instead:

```
/plugin marketplace add dorywoof/agentreplayer
/plugin install agentreplayer@agentreplayer
```

Then type `/agentreplayer:replay`, or just ask *"make a replay of this session"*. Claude runs the CLI for you, writes the HTML next to your project and tells you what was redacted. Arguments pass through, for example `/agentreplayer:replay --list`.

### As a skill in Codex, Gemini CLI, OpenCode, Copilot, Cursor…

Most agents now read the open [Agent Skills](https://agentskills.io) format (`SKILL.md`). One command installs the replay skill into every agent it finds on your machine:

```bash
npx agentreplayer install-skill
```

| Agent | Installed to |
|---|---|
| Shared folder several agents read | `~/.agents/skills/agentreplayer/` (always) |
| Claude Code | `~/.claude/skills/agentreplayer/` |
| Codex | `~/.codex/skills/agentreplayer/` |
| Gemini CLI | `~/.gemini/skills/agentreplayer/` |
| Qwen Code | `~/.qwen/skills/agentreplayer/` |
| OpenCode | `~/.config/opencode/skills/agentreplayer/` |
| GitHub Copilot | `~/.copilot/skills/agentreplayer/` |
| Cursor | `~/.cursor/skills/agentreplayer/` |
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

> Only Claude Code and Codex have been tested against real logs so far. The others are built from their documented formats and tested with fixtures. If a session from your agent doesn't replay correctly, please [open an issue](https://github.com/dorywoof/agentreplayer/issues) with a redacted sample.

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

One command gives you a link:

```bash
npx agentreplayer --share
```

This uploads the redacted replay as a **secret GitHub Gist** and prints a link like `https://dorywoof.github.io/agentreplayer/view.html#<gist-id>`. It uses the GitHub CLI if you're logged in (`gh auth login`), otherwise a `GITHUB_TOKEN` with the `gist` scope. Secret gists aren't listed or searchable, but anyone with the link can view it. Delete the gist to take it down. `--share` refuses to run with `--no-redact`.

The viewer loads the gist in a sandboxed iframe, so a replay can't run code on the viewer's site. Add `/e42` after the gist id to open at event 42 (`view.html#<id>/e42`).

The output is also a plain static file, so you can host it anywhere else: a `gh-pages` branch, Netlify / Vercel drop, Slack, e-mail.

> ⚠️ Redaction catches common secret formats, but it can't know everything that is private to you. Skim the replay before posting it publicly.

## About the cost estimate

When the agent records what a session cost (Cline, Roo, Kilo, OpenCode), that number is shown. Otherwise cost is estimated from public per-token API list prices (including cache reads and writes) for the Claude models it knows about. If you're on a subscription plan, it shows what the session *would* cost on the API. For models it has no price for, only token counts are shown. You can supply your own prices:

```json
{ "gpt-6.1": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }
```

```bash
npx agentreplayer --pricing prices.json
```

## Roadmap

- [ ] Cursor and Windsurf built-in chat (stored in proprietary SQLite blobs)
- [ ] Goose, Crush, Droid and Kiro sessions
- [ ] Export to GIF / MP4 for social posts
- [ ] Subagent (sidechain) lanes
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
