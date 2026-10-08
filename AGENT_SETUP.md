# Relay setup guide for AI agents

> **For the human:** paste this into Claude Code, Codex or Antigravity:
>
> ```
> Set up Relay for me by following https://raw.githubusercontent.com/AeroUp/Relay/main/AGENT_SETUP.md
> ```

**For the AI agent reading this:** the user wants Relay installed on this machine. When their main AI agent hits its usage limit mid-task, Relay hands the task to another agent (Codex, Claude or Antigravity). When the limit resets, it wakes the first agent to review the work and finish. Follow the steps below in order, run the commands yourself, and keep the user informed in plain language. Each step says what to check before moving on.

## Ground rules

- Install for the current user only. Never use `sudo` or admin rights, and never change system settings.
- Don't edit agent config files by hand. `install` does it, makes a backup first (`*.bak-relay`), and only touches the `relay` entries and hooks.
- Never ask the user to paste passwords or API keys into the chat. Relay doesn't need any.
- If a step fails, show the user the exact error, try the fix listed for it, and stop if it still fails.

## 1. Check prerequisites

```bash
node --version
git --version
```

- **Node:** must be v20 or newer. If it's missing or older, tell the user to install the LTS from https://nodejs.org, then stop.
- **git:** optional. Without it, use the zip download in step 3.

Relay needs **Claude Code** for automatic relays, plus at least one partner agent. All of them must be installed and signed in once (signing in is the user's job):

| Agent | How to check | If it's missing |
|---|---|---|
| Claude Code | `claude --version` | https://claude.com/claude-code |
| Codex | `codex --version`, or the Codex desktop app is installed | `npm i -g @openai/codex`, or the desktop app |
| Antigravity CLI | `agy --version` | Windows: `irm https://antigravity.google/cli/install.ps1 \| iex`. macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

## 2. Ask the user three quick questions

Skip any the user has already answered.

1. **Who should take over when Claude runs out?** The default order is Codex, then Antigravity.
2. **Should relays survive a reboot?** The default is yes. This adds a small login item, which is a hidden script that exits right away if nothing is pending.
3. **How much may the partner do unattended?** Relay matches the access level of the session that ran out:
   - accept-edits → it may edit files;
   - bypass-permissions → full access.

   For sessions that ask before every action, the default is "may edit files in the project". A more cautious alternative is "read only".

## 3. Get the code into a permanent folder

The installed hooks point at this folder, so **don't use a temp folder**. Use the location the user asks for. Otherwise, use `<home>/tools/Relay`.

```bash
git clone https://github.com/AeroUp/Relay.git ~/tools/Relay
```

- **Already cloned?** Run `git -C ~/tools/Relay pull` instead.
- **No git?** Download https://github.com/AeroUp/Relay/archive/refs/heads/main.zip, unzip it, and rename the folder to `Relay`.

## 4. Run the offline self-test

This step makes no AI calls and uses no quota.

```bash
node ~/tools/Relay/bin/relay.mjs selftest
```

Every line should start with ✔. If any line starts with ✖, stop and show the user the output.

## 5. Install

```bash
node ~/tools/Relay/bin/relay.mjs install
```

If the user said **no to the reboot login item**, add `--no-autostart`.

For each agent it finds, this registers the `relay` MCP server and copies the `relay` skill. It also:
- in Claude Code, adds three hooks: `StopFailure`, `SessionStart` and `UserPromptSubmit`;
- in Codex and Antigravity, pre-approves the Relay tools.

Then apply the user's answers from step 2, if they differ from the defaults:

```bash
node ~/tools/Relay/bin/relay.mjs config set fallback_chain '["antigravity","codex"]'
node ~/tools/Relay/bin/relay.mjs config set default_access read
```

## 6. Verify

```bash
node ~/tools/Relay/bin/relay.mjs doctor --json
```

Check three things in the output:
- `wired_into` includes `claude`.
- `config.enabled` is `true`.
- At least one agent in `fallback_chain` has `"installed": true`.

If Claude Code is installed, `claude mcp list` should show `relay … ✔ Connected`, and `~/.claude/settings.json` should contain hooks that run `relay.mjs hook …`.

Don't trigger a real usage limit to test it.

## 7. Tell the user

Summarize in a few lines:
- Relay is active. If Claude Code stops on a usage limit, the partner takes over automatically, and Claude resumes after the reset to review and finish. They'll get desktop notifications.
- They must **restart** Claude Code, Codex and Antigravity, or start new sessions, for this to take effect.
- They can also tag out on purpose: "I'm almost out of usage, hand this to codex", or the `/relay` skill.
- To check on relays: `node ~/tools/Relay/bin/relay.mjs list`.
- Handoff notes go in `<project>/.relay/baton.md`. That folder is git-ignored.
- To remove Relay: `node ~/tools/Relay/bin/relay.mjs uninstall`.

If the user also wants their agents to ask each other questions, review each other's code, or make images together, offer to set up the companion project **Tag-Team**. Its guide is at https://raw.githubusercontent.com/AeroUp/Tag-Team/main/AGENT_SETUP.md.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor` shows an agent as "not installed" but it is | `node bin/relay.mjs config set agents.<claude\|codex\|antigravity>.path "<full path to the exe>"`, then run `install` again |
| Claude Code: `claude mcp add-json` failed | Make sure `claude` runs in a terminal, then run `install --only claude` again |
| Codex on Windows: "setup refresh had errors" | Nothing to do. Relay switches Codex to its unelevated sandbox automatically on first use |
| Antigravity skill doesn't appear | Different versions read skills from different folders. Copy `skills/relay` into the folder the user's version uses, e.g. `~/.gemini/config/skills/` |
| Hooks don't fire | Claude Code wasn't restarted, or `relay.enabled` is `false` (`relay config set enabled true`) |
