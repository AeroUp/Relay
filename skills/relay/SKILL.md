---
name: relay
description: Usage-limit relay. Hand the current task to another AI agent (Codex, Claude or Antigravity) when you are at or near your usage limit, and get woken up automatically when your limit resets to review its work and finish. Use when the user says "tag out", "hand this off", "I'm almost out of usage", "continue this with codex/antigravity/claude", "keep going while I'm limited", "wake up when my limit resets", or asks about a relay already in progress.
---

# Relay: tag out, tag back in

When an agent runs out of usage mid-task, another agent picks up from a handoff note (the **baton**). When the first agent's limit resets, Relay wakes it up to review what happened and finish the job.

Relay is an MCP server called `relay`. In Claude Code its tools appear as `mcp__relay__status`, `mcp__relay__handoff` and `mcp__relay__relays`.

## What happens automatically (Claude Code)

Relay installs Claude Code hooks. If Claude hits its usage limit mid-task, nobody has to do anything:
1. The `StopFailure` hook reads the reset time and writes a baton to `<project>/.relay/baton.md` from the transcript: the original request, follow-up messages, todo list, files touched and last messages.
2. The first available agent in the fallback chain (default: Codex, then Antigravity) continues the task in the background, with the access level the session had.
3. When the limit resets, Claude's own session is resumed headless. It gets the partner's report, reviews the diff, fixes problems and finishes.
4. If the user comes back to the session first, the partner's progress or report is added to their next message instead.

The user gets a desktop notification at each step.

## Tagging out on purpose (any agent)

Do this when you're close to your limit, or when another agent fits the job better:

1. **Write a real baton.** It's the only thing the next agent knows. Include:
   - **Goal**: the user's request in their own words, plus any constraints.
   - **Done so far**: with file paths, and what you've verified.
   - **Left to do**: an ordered list, with a concrete first step.
   - **Key files & decisions**: what's where, why you chose X over Y, traps to avoid.
   - **How to verify**: commands to build or test, and what success looks like.
   - **Open questions**: things to decide sensibly without asking.
2. Call **`status`** if you're not sure who's available.
3. Call **`handoff`** with these parameters:
   - `to`: `codex`, `claude`, `antigravity` or `auto`.
   - `baton`: the markdown above.
   - `task`: one paragraph describing the overall task.
   - `cwd`: the project's absolute path.
   - `access`: `write` for normal work. Use `full` only if the user's session already bypasses permissions.
   - `resume`: when to bring you back.
     - `after_reset`: you're limited. Also pass `reset_at` if you know it, e.g. "3pm" or "in 2 hours".
     - `after_handoff`: resume automatically to review once the partner finishes.
     - `on_next_message`: you see the report when the user next writes. This is the default when you aren't limited.
     - `never`: the partner owns the task.
   - `from_session_id`: in Claude Code, pass `${CLAUDE_SESSION_ID}`. In other agents, leave it out.
4. Tell the user who took over, the relay id, and when you'll be back. Then stop working on the same files.

## When you get woken up

You'll get a message starting with `[Relay]`.
1. Read `.relay/baton.md`. Partners append "Report from …" sections to it.
2. Run `git status` and `git diff` to see what actually changed. Don't rely on the reports alone.
3. Review the partner's work like a strict code reviewer, and fix bugs and gaps.
4. Finish the original task. Then summarize what the partner did, what you changed, and what's left.

## Managing relays

- `relays` with no id lists recent relays. With an id, it shows that relay's log.
- To stop a relay and its running partner: `relays {id, action: "cancel"}`.
- To wake the primary agent immediately: `relays {id, action: "resume_now"}`.
- CLI equivalents: `{{CLI}} list`, `{{CLI}} show|cancel|now <id>`, `{{CLI}} doctor`.

## Autopilot (from a terminal)

`{{CLI}} run "build the thing" --chain claude,codex,antigravity --cwd <dir>`

This starts the task on the first agent and fails over across the chain on usage limits. When the first agent's limit resets, it comes back to finish.

## Settings

Change these with `{{CLI}} config set <key> <value>`:
- `fallback_chain`: who takes over, in order. Example: `["codex","antigravity"]`.
- `auto_fallback`: set to `false` to only wait and resume, without starting a partner.
- `on_reset`: what happens when your limit resets while the partner is still working.
  - `wait` (default): let the partner finish, then resume.
  - `takeover`: stop the partner as soon as you're back.
  - `none`: the partner owns the task.
- `default_access`: the access level for unattended runs when the session asked before every action.
- `enabled`: set to `false` to turn off automatic relays from Claude Code hooks.
