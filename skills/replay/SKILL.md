---
name: replay
description: Turn the current Claude Code session (or another coding-agent session) into a shareable, video-like HTML replay with diffs, tool calls, token/cost stats and automatic secret redaction. Use when the user asks to replay, share, export, record, show off or summarize visually what was done in this session, or asks for a replay of an earlier Claude Code, Codex, Gemini CLI, OpenCode, Cline, Roo, Copilot CLI, Amp or Aider session.
argument-hint: "[--list | --pick N | path/to/log] [--title \"…\"] [--no-thinking]"
allowed-tools: Bash(npx -y @dorywoof/agentreplay*), Bash(npx @dorywoof/agentreplay*)
---

# Replay this session

agentreplay is a zero-dependency CLI on npm (`@dorywoof/agentreplay`). It reads
agent session logs from disk and writes one self-contained HTML file that plays
the session back like a video. It runs locally and uploads nothing.

## Default: replay the current session

The current session is the Claude Code log written most recently, so this
picks it up without needing an id:

```bash
npx -y @dorywoof/agentreplay@latest --agent claude --session "${CLAUDE_SESSION_ID}" -o "agentreplay-$(date +%Y%m%d-%H%M).html"
```

- If `${CLAUDE_SESSION_ID}` is empty or unrecognised, drop the `--session`
  flag: without it, the newest session is used, which is this one.
- Write the file in the current working directory unless the user names
  another place. It opens in the browser automatically; add `--no-open` if the
  user asked not to open it, or when running non-interactively.
- Pass a title with `--title "…"` when the session has an obvious one-line
  summary; otherwise the CLI picks one.

## Other requests

| User wants | Command |
|---|---|
| Choose an earlier session | `npx -y @dorywoof/agentreplay@latest --list`, then `--pick N` |
| Replay another agent (Codex, Gemini CLI, Cline…) | `--agent codex` (see `--agents` for keys) |
| Replay a specific log file | pass the path as the first argument |
| Hide reasoning | `--no-thinking` |
| Keep file paths but still strip secrets | `--keep-paths` |
| Raw data instead of HTML | `--json` |

Pass through any arguments the user gave this skill (`$ARGUMENTS`).

## Rules

- Never pass `--no-redact` unless the user explicitly asks for it, and if they
  do, warn them that secrets, e-mails and home paths will be in the file.
- Redaction covers common secret formats but not everything private. Tell the
  user to skim the replay before posting it publicly.
- Don't upload or publish the HTML anywhere yourself. Offer the sharing options
  below and let the user choose.

## After it runs

Report in two or three lines: the output path (as a link), the one-line stats
the CLI printed (events, tool calls, files, minutes, cost), and what was
redacted. Then mention the ways to share it: drag the file onto Netlify Drop, attach it
in Slack/Discord, or commit it to a GitHub Pages branch. `#e42` at the end of the
URL opens the replay at event 42 and `?static` shows everything at once.

If the command fails because Node is missing, say that agentreplay needs
Node.js 18 or newer.
