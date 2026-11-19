---
name: replay
description: Turn the current coding-agent session into a shareable, video-like HTML replay with diffs, tool calls, token/cost stats and automatic secret redaction. Use when the user asks to replay, share, export, record or show off what was done in this session, or asks for a replay of an earlier Claude Code, Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI, Qwen, Amp or Aider session.
argument-hint: "[--list | --pick N | path/to/log] [--title \"…\"] [--no-thinking]"
allowed-tools: Bash(npx -y agentreplayer*), Bash(npx agentreplayer*)
---

# Replay this session

agentreplay (https://github.com/dorywoof/agentreplay) is a zero-dependency CLI on npm (`agentreplayer`). It reads
agent session logs from disk and writes one self-contained HTML file that plays
the session back like a video. It runs locally and uploads nothing. It works the
same no matter which agent is running this skill.

## Default: replay the current session

Run this in the user's shell, with `<agent>` set to the agent you are:

```bash
npx -y agentreplayer@latest --agent <agent> -o agentreplay.html
```

| You are | `<agent>` |
|---|---|
| Claude Code | `claude` (also add `--session "${CLAUDE_SESSION_ID}"`) |
| OpenAI Codex | `codex` |
| Gemini CLI | `gemini` |
| Qwen Code | `qwen` |
| OpenCode | `opencode` |
| GitHub Copilot CLI | `copilot` |
| Cline / Roo Code / Kilo Code | `cline` / `roo` / `kilo` |
| Amp | `amp` |
| Aider | `aider` |
| Not sure | leave `--agent` out: the newest session of any agent is used |

- The session being written right now is the newest log of that agent, so
  this picks it up without an id. If a `--session` value is empty or not found,
  the CLI falls back to the newest session by itself.
- Write the file in the current working directory unless the user names
  another place; use a more descriptive file name when there is an obvious
  one. The file opens in the browser; add `--no-open` if the user asked not to
  open it or there is no desktop.
- Add `--title "…"` when the session has an obvious one-line summary.

## Other requests

| User wants | Add |
|---|---|
| Choose an earlier session | run with `--list` first, then `--pick N` |
| See which agents have sessions on this machine | `--agents` |
| Replay a specific log file | the file path as the first argument |
| Hide reasoning | `--no-thinking` |
| Keep file paths but still strip secrets | `--keep-paths` |
| Raw data instead of HTML | `--json` |
| Compare 2–6 sessions side by side | `race <a> <b> [c …]` instead of the default command; each is a log file, a `--list` number, or an agent name (its newest session; a repeated name takes the next newest), e.g. `race claude codex gemini` |
| See where tokens/money went across recent sessions | `insights` (add `--days N`); summarize the "What to do" section for the user |

Pass through any arguments the user gave this skill.

## Rules

- Never pass `--no-redact` unless the user explicitly asks for it, and if they
  do, warn them that secrets, e-mails and home paths will be in the file.
- Redaction covers common secret formats but not everything private. Tell the
  user to skim the replay before posting it publicly.
- Don't upload or publish the HTML anywhere on your own. Add `--share` only
  when the user asks for a link; it uploads the redacted replay as a secret
  GitHub Gist that anyone with the link can view.

## After it runs

Report in two or three lines: the output path, the one-line stats the CLI
printed (events, tool calls, files, minutes, cost), and what was redacted. Then
mention the ways to share it: rerun with `--share` for a link (needs
`gh auth login` or a GITHUB_TOKEN), drag the file onto Netlify Drop, or attach
it in Slack/Discord. If `--share` was used, give the printed link and say
that deleting the gist takes it down. `#e42` at the end of the URL opens the
replay at event 42 and `?static` shows everything at once.

If the command fails because Node is missing, say that agentreplay needs
Node.js 18 or newer.
