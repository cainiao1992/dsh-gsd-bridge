# dsh-gsd-bridge

Mount [GSD Core](https://github.com/open-gsd/gsd-core) — the spec-driven development system (Git. Ship. Done.: Discuss → Plan → Execute → Verify → Ship) — onto [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as native `/gsd-*` slash commands.

`@opengsd/gsd-core` is consumed as a plain npm dependency and adapted **at dispatch time**; nothing is rewritten on disk.

## Features

- **71 workflow commands** — the full GSD Core command surface becomes `/gsd-*` slash commands: `/gsd-new-project`, `/gsd-onboard`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-verify-work`, `/gsd-ship`, `/gsd-next`, `/gsd-help` …
- **Session orientation** — when a session starts in a directory with a GSD project (`.planning/`), the model is oriented with the current `STATE.md` head, mirroring GSD Core's `SessionStart` hook.
- **Upstream-faithful, zero fork** — command bodies are adapted in memory (frontmatter stripped, `@~/.claude/gsd-core/...` includes inlined, tool vocabulary renamed, the `gsd_run` shim re-pointed). The gsd-core package itself is never modified, so an upstream upgrade is just a version bump.
- **Interoperable project state** — GSD state lives in the project (`.planning/`), so a Claude Code session and a DeepSeek Harness session can drive the same project interchangeably.

## Requirements

- Node.js ≥ 24
- A DeepSeek Harness `web` (or base) profile already mounted — it must provide the `fs` and `commands` services.

## Install

Direct from GitHub (no npm publish). The `prepare` script builds `lib/` automatically on install.

```bash
dsh plugin --profile web add github:cainiao1992/dsh-gsd-bridge --config.auto-install-peers=false
```

`dsh plugin` forwards its arguments verbatim to pnpm inside the profile directory. `--config.auto-install-peers=false` avoids the incomplete rc-era peer graph of the `@deepseek-ai/dsh-*` packages — in a profile the peers are already provided by the host bundles, so they are not re-installed. Equivalent manual form:

```bash
cd ~/.dsh/profiles/web
corepack pnpm add github:cainiao1992/dsh-gsd-bridge --config.auto-install-peers=false
```

Then mount it by replacing the local absolute path with the bare package name (the loader resolves bare names against the config-file directory → the profile's `node_modules`):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: gsd-bridge
      name: dsh-gsd-bridge
```

## Usage

Type any `/gsd-*` command in the DeepSeek Harness Web UI.

```text
/gsd-help            # workflow catalog
/gsd-new-project     # greenfield: questioning → research → requirements → roadmap
/gsd-onboard         # existing codebase: map → ingest → initialize planning
/gsd-plan-phase 1    # create a detailed plan for phase 1
/gsd-execute-phase 1 # execute all plans in the phase
/gsd-next            # state-aware router
```

## How it works

Every `/gsd-*` dispatch adapts the gsd command in memory before it reaches the model:

| Adaptation | Details |
|---|---|
| Frontmatter strip | `allowed-tools` / `requires` / `effort` are dropped (the dsh tool registry owns tool governance); `description` and `argument-hint` register the command. |
| Include inlining | `@~/.claude/gsd-core/...` `<execution_context>` references (which Claude Code resolves at prompt-assembly time) are read and inlined, budget-capped, cycle-safe, and recursive. |
| Vocabulary rewrite | `` `Read` ``→`` `read` `` , `Agent`→`subagent`, `AskUserQuestion`→`ask_user_question`, `/gsd:x`→`/gsd-x`, Copilot `<runtime_note>` blocks dropped. |
| Shim rewrite | `$(git rev-parse --show-toplevel …)` → the installed package root, so `gsd_run` / `gsd-tools.cjs` resolve immediately. |
| Argument substitution | `$ARGUMENTS` / `${ARGUMENTS}` → the text after the command name. |

Dispatch uses `agent.steer()` (user-message semantics); session orientation uses `agent.inject()` (a non-waking notice).

## Hook coverage

Of GSD Core's ~20 Claude Code hooks, only the `SessionStart` state orientation is ported (`agent/session-start` event → `.planning/STATE.md` injection). Tool-interception hooks (`read-guard`, `worktree-path-guard`, …) are covered by dsh's native permission/sandbox stack; update-check hooks are irrelevant against a pinned npm dependency.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `vendorRoot` | installed `@opengsd/gsd-core` | package root to bridge (a fork or local checkout) |
| `includeBudgetChars` | `220000` | per-command include-inlining character budget |
| `stateCapChars` | `3500` | `STATE.md` orientation truncation |
| `orientation` | `true` | disable session orientation |

The recommended local override for `vendorRoot` is `~/.dsh/gsd-core` — a package-root install (with `commands/`, `agents/`, and the `gsd-core/` runtime root — the DSH counterpart of `~/.claude/gsd-core`):

```yaml
- id: gsd-bridge
  name: 'dsh-gsd-bridge'
  config:
    vendorRoot: /Users/<you>/.dsh/gsd-core
    includeBudgetChars: 100000
```

## Development

```bash
npm install --legacy-peer-deps   # rc-era dsh npm peer graph is incomplete for local dev
npm run build                    # tsc → lib/
```

Type contracts come from the published `@deepseek-ai/dsh-*` declarations (`dsh-commands`, `dsh-fs`, `dsh-agent`, `dsh-llm`).

## Known limitations

- gsd-core is pinned to `1.12.0`; an upgrade requires re-validating the command-body format.
- The dsh npm packages are rc-phase; installs need `--config.auto-install-peers=false` (drop it once the upstream peer graph is complete).
- PreToolUse-class hooks are not ported (the dsh native stack covers them); `write-guard` (protection against catastrophic `.planning/` overwrites) is a known gap.
- GSD named agents (`gsd-executor`, …) map to subagent delegation with persona-file prompts, not native agent types.

## License

MIT (this repository's code). `@opengsd/gsd-core` is distributed as a dependency under its own MIT license.
