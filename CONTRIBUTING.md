# Contributing to Relay

Thanks for helping! Relay is plain Node.js (20+) with **zero dependencies**, and we want to keep it that way.

## Setup

```bash
git clone https://github.com/AeroUp/Relay.git
cd Relay
npm test                      # offline self-test, spends no AI usage
node bin/relay.mjs doctor     # what it can see on your machine
```

To try your changes in your agents, run `node bin/relay.mjs install` from your clone. The MCP config points at whatever folder you install from.

## Layout

```
bin/relay.mjs        CLI entry point (also `mcp`, `waker`, `hook` and the `_job` runner)
src/app.mjs          Relay's identity and default config
src/relay.mjs        relay engine: tickets, batons, waker, Claude Code hook handlers
src/ops.mjs          handoff / autopilot / status
src/tools.mjs        MCP tool definitions
src/install.mjs      wiring into agents, hooks, login item
src/core/            shared with Tag-Team (see below)
skills/relay/        the Agent Skill installed into each agent
test/selftest.mjs    offline tests
```

## The shared core

`src/core/` is **byte-identical** in Relay and [Tag-Team](https://github.com/AeroUp/Tag-Team). It holds the agent adapters, usage-limit parsing, the job system, the MCP protocol layer and the installer kit. If you change it here, open the same change on Tag-Team too, or mention it in your PR and we'll port it. Anything app-specific belongs outside `src/core/`.

## Guidelines

- No runtime dependencies, no build step.
- Keep it working on Windows, macOS and Linux. CI runs all three.
- Agent CLIs change often. When you touch an adapter in `src/core/agents.mjs`, say which CLI version you tested against.
- New usage-limit message formats are very welcome. Add a test case to `test/selftest.mjs`.
- Never send anything to a network service other than the agent CLIs themselves.
