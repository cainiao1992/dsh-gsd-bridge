/**
 * GSD Core bridge for DeepSeek Harness.
 *
 * Mounts the `@opengsd/gsd-core` spec-driven development system (Git. Ship.
 * Done.) onto a dsh composition: every GSD workflow ships as a `/gsd-*` slash
 * command, and a session rooted in a GSD project (`.planning/`) starts with a
 * state orientation notice.
 *
 * The gsd-core package is consumed as a plain npm dependency. Its Claude
 * Code–dialect command bodies are adapted at dispatch time — frontmatter is
 * stripped, `@~/.claude/gsd-core/...` includes are inlined, tool vocabulary is
 * renamed, and the `gsd_run` shim is pointed at the installed runtime — never
 * rewritten on disk, so an upstream gsd-core upgrade is a version bump.
 *
 * @module dsh-gsd-bridge
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import s from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gsd-bridge'

/** The filesystem service reads command bodies; the command registry hosts the `/gsd-*` surface. */
export const inject = ['fs', 'commands']

/** Deployment-tunable bridge settings; invalid values fail plugin load. */
export interface Config {
  /**
   * Package root of the gsd-core install to bridge, overriding the installed
   * `@opengsd/gsd-core` dependency (for a fork or local checkout).
   */
  vendorRoot?: string
  /** Total character budget for inlined `<execution_context>` includes per dispatched command. */
  includeBudgetChars: number
  /** Maximum characters of `.planning/STATE.md` injected as session orientation. */
  stateCapChars: number
  /** Whether sessions rooted in a GSD project receive the orientation notice. */
  orientation: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config = s.object({
  vendorRoot: s.string(),
  includeBudgetChars: s.number().default(220_000),
  stateCapChars: s.number().default(3_500),
  orientation: s.boolean().default(true),
})

/** Resolved on-disk layout of one gsd-core install. */
export interface GsdLayout {
  /** The gsd-core package root (`@opengsd/gsd-core`). */
  root: string
  /** The Claude-Code-style install root (`<root>/gsd-core`): target of `@~/.claude/gsd-core/...` includes. */
  installRoot: string
  /** Slash-command source directory (`<root>/commands/gsd`). */
  commandsDir: string
  /** Persona definitions (`<root>/agents`), referenced by the dispatch preamble. */
  agentsDir: string
}

/** Filesystem reads the bridge performs, narrowed from the injected service. */
interface BridgeFs {
  /** Resolve one path (absolute, or relative to `cwd` when given) to a target. */
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>
  /** Read one target's UTF-8 content. */
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
}

/** Bind the injected filesystem service to the narrowed bridge face. */
function bridgeFs(ctx: Context): BridgeFs {
  return {
    resolve: (path, opts) => ctx.fs.resolve(path, opts),
    readText: (target, signal) => ctx.fs.readText(target, signal),
  }
}

/**
 * Resolve the gsd-core package root: the configured override, else the
 * installed dependency.
 *
 * @param config Validated plugin config.
 * @returns The gsd-core package root path.
 * @throws When `@opengsd/gsd-core` is not installed and no override is set.
 */
export function resolveVendorRoot(config: Config): string {
  if (config.vendorRoot !== undefined && config.vendorRoot !== '') return config.vendorRoot
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('@opengsd/gsd-core/package.json'))
}

/** Claude Code tool names mapped to their DeepSeek Harness equivalents. */
const TOOL_RENAMES: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Agent: 'subagent',
  Task: 'subagent',
  WebSearch: 'web_search',
}

/** Scalar frontmatter of one gsd command; only the fields this bridge consumes. */
interface CommandFrontmatter {
  meta: { description?: string, 'argument-hint'?: string }
  body: string
}

/**
 * Split one gsd command file into its scalar frontmatter and body. List-valued
 * frontmatter (`allowed-tools`, `requires`) is ignored: the dsh tool registry
 * owns tool governance.
 *
 * @param text The complete command file content.
 * @returns Parsed frontmatter and the body after the closing delimiter.
 */
function parseFrontmatter(text: string): CommandFrontmatter {
  const meta: { description?: string, 'argument-hint'?: string } = {}
  if (!text.startsWith('---')) return { meta, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta, body: text }
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-zA-Z-]+):\s*(.*)$/.exec(line)
    if (match === null || match[1] === undefined || match[2] === undefined) continue
    let value = match[2].trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    meta[match[1] as 'description' | 'argument-hint'] = value
  }
  let body = text.slice(end + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  return { meta, body }
}

/**
 * Rewrite Claude Code runtime vocabulary in one gsd text to DeepSeek Harness's:
 * drop Copilot runtime notes, pin the `gsd_run` shim root to the installed
 * package, rename tools, and normalize `/gsd:` command syntax.
 *
 * @param text gsd source text (command body or include content).
 * @param layout The gsd-core install the shim should resolve against.
 * @returns The adapted text.
 */
function adaptBody(text: string, layout: GsdLayout): string {
  let out = text
  out = out.replace(/<runtime_note>[\s\S]*?<\/runtime_note>\s*/g, '')
  out = out.replaceAll('$(git rev-parse --show-toplevel 2>/dev/null || pwd)', layout.root)
  out = out.replaceAll('/gsd:', '/gsd-')
  out = out.replaceAll('AskUserQuestion', 'ask_user_question')
  out = out.replaceAll('TodoWrite', 'todo_write')
  out = out.replace(/`([A-Z][A-Za-z]+)`/g, (whole, tool: string) =>
    Object.hasOwn(TOOL_RENAMES, tool) ? `\`${TOOL_RENAMES[tool]}\`` : whole)
  out = out.replace(/\bthe (Read|Write|Edit|Bash|Grep|Glob|Agent|Task|WebSearch|WebFetch) tool\b/g, (whole, tool: string) =>
    Object.hasOwn(TOOL_RENAMES, tool) ? `the ${TOOL_RENAMES[tool]} tool` : whole)
  return out
}

/** Remaining include budget, shared across one command's recursive expansion. */
interface IncludeBudget {
  left: number
}

/** The `@~/.claude/gsd-core/...` include token as written by gsd command bodies. */
const INCLUDE_PATTERN = /@(?:~|\$HOME\/)\.claude\/gsd-core\/([A-Za-z0-9._/-]+\.md)/g

/**
 * Inline-expand the `@~/.claude/gsd-core/...` references Claude Code resolves
 * at prompt-assembly time. Nested includes recurse; each distinct path expands
 * once per command (cycle-safe); the total is bounded by the budget.
 *
 * @param text Adapted text holding include tokens.
 * @param seen Paths already expanded for this command.
 * @param budget Shared character budget; exhausted includes are truncated.
 * @param layout The gsd-core install to read from.
 * @param fs Filesystem reads.
 * @param signal Abort signal forwarded to filesystem reads.
 * @returns The text with every token replaced by marked content blocks.
 */
async function expandIncludes(
  text: string,
  seen: Set<string>,
  budget: IncludeBudget,
  layout: GsdLayout,
  fs: BridgeFs,
  signal: AbortSignal | undefined,
): Promise<string> {
  for (const match of text.matchAll(INCLUDE_PATTERN)) {
    const rel = match[1]
    const token = match[0]
    if (rel === undefined || token === undefined || seen.has(rel)) continue
    seen.add(rel)
    let content: string
    try {
      content = await fs.readText(await fs.resolve(join(layout.installRoot, rel)), signal)
    } catch {
      text = text.replaceAll(token, `<!-- gsd-bridge: include unreadable: ${rel} -->`)
      continue
    }
    if (content.length > budget.left) {
      content = content.slice(0, Math.max(budget.left, 0)) + '\n<!-- gsd-bridge: include truncated at budget -->'
    }
    budget.left -= content.length
    const nested = await expandIncludes(adaptBody(content, layout), seen, budget, layout, fs, signal)
    const block = `\n<!-- gsd-bridge begin ${rel} -->\n${nested}\n<!-- gsd-bridge end ${rel} -->\n`
    text = text.replaceAll(token, block)
  }
  return text
}

/** Dispatch preamble: how the workflow's Claude Code assumptions map onto this harness. */
function preamble(layout: GsdLayout): string {
  return [
    'You are executing a GSD Core workflow running on DeepSeek Harness (DSH) instead of Claude Code.',
    '- DSH tool names: read, write, edit, bash, grep, glob, ask_user_question, todo_write, web_search, subagent (fresh-context delegation), workflow (multi-agent orchestration).',
    `- GSD named agents (e.g. gsd-project-researcher, gsd-executor-1) are persona definitions, not installed agent types. To spawn one, delegate via the subagent tool and open the child prompt with the persona file from ${layout.agentsDir}/<name>.md (read it first when the workflow does not inline the persona).`,
    '- The gsd-tools runtime is pre-installed: bash shim lines below already resolve gsd_run from the installed gsd-core package. Run bash with the project working directory as workdir.',
    `- Relative references like \`gsd-core/workflows/...\` or \`gsd-core/references/...\` resolve under ${layout.installRoot}, not under the project.`,
    '- Workflow artifacts (.planning/, commits, PR descriptions) belong to the current project directory.',
    '- ask_user_question replaces AskUserQuestion everywhere, including inside multi-step gates.',
    '',
    'The user invoked the slash command below. Execute its workflow end-to-end, preserving every gate (validation, approvals, commits, routing).',
    '',
  ].join('\n')
}

/**
 * Assemble one gsd command into a dispatchable workflow prompt.
 *
 * @param file Command filename under `commands/gsd/`.
 * @param rawInput Exact user input after the command name.
 * @param layout The gsd-core install to read from.
 * @param budgetChars Include character budget.
 * @param fs Filesystem reads.
 * @param signal Abort signal forwarded to filesystem reads.
 * @returns The complete workflow prompt.
 */
async function assemble(
  file: string,
  rawInput: string,
  layout: GsdLayout,
  budgetChars: number,
  fs: BridgeFs,
  signal: AbortSignal | undefined,
): Promise<string> {
  const parsed = parseFrontmatter(await fs.readText(await fs.resolve(join(layout.commandsDir, file)), signal))
  const budget: IncludeBudget = { left: budgetChars }
  let expanded = await expandIncludes(adaptBody(parsed.body, layout), new Set(), budget, layout, fs, signal)
  const args = rawInput.trim()
  expanded = expanded.replaceAll('${ARGUMENTS}', args).replaceAll('$ARGUMENTS', args)
  return `${preamble(layout)}\n${expanded}`
}

/** Whether the session is a top-level (non-delegated) session worth orienting. */
function isTopLevel(agent: Agent): boolean {
  const header = agent.session.header
  if (header.origin === 'subagent') return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return typeof header.cwd === 'string' && header.cwd !== ''
}

/**
 * Mount the bridge: register every `/gsd-*` command from the installed
 * gsd-core package and orient top-level sessions in GSD projects.
 *
 * @param ctx Plugin context (`fs` and `commands` injected).
 * @param config Validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const layout: GsdLayout = {
    root: resolveVendorRoot(config),
    installRoot: '',
    commandsDir: '',
    agentsDir: '',
  }
  layout.installRoot = join(layout.root, 'gsd-core')
  layout.commandsDir = join(layout.root, 'commands', 'gsd')
  layout.agentsDir = join(layout.root, 'agents')
  const fs = bridgeFs(ctx)

  const disposers: Array<() => void> = []
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers) dispose()
  }, 'gsd-bridge: dispose command registrations')

  ctx.on('agent/session-start', ({ agent }) => {
    if (!config.orientation || !isTopLevel(agent)) return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    void (async () => {
      try {
        let state: string
        try {
          state = await fs.readText(await fs.resolve('.planning/STATE.md', { cwd }))
        } catch {
          return // No GSD project in this workspace: nothing to orient.
        }
        if (state.trim() === '') return
        if (state.length > config.stateCapChars) state = `${state.slice(0, config.stateCapChars)}\n...(truncated)`
        const text = `GSD Core project detected in ${cwd} (.planning/STATE.md below). `
          + 'Follow the GSD phase loop; use /gsd-next when unsure of the next step and /gsd-help for the workflow catalog.\n\n'
          + state
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'gsd-bridge', form: 'notice', summary: 'GSD session orientation from .planning/STATE.md' },
        }))
      } catch (error) {
        ctx.logger.warn('gsd-bridge: orientation failed: %o', error)
      }
    })()
  })

  void (async () => {
    let entries
    try {
      entries = await ctx.fs.listDir(await ctx.fs.resolve(layout.commandsDir))
    } catch (error) {
      ctx.logger.error('gsd-bridge: cannot list %s: %o', layout.commandsDir, error)
      return
    }
    let count = 0
    for (const entry of entries) {
      if (disposed) break
      if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue
      const base = entry.name.slice(0, -3)
      if (!/^[a-z][a-z0-9_-]*$/.test(base)) continue
      let text: string
      try {
        text = await ctx.fs.readText(entry.target)
      } catch (error) {
        ctx.logger.warn('gsd-bridge: skip %s: %o', entry.name, error)
        continue
      }
      const { meta } = parseFrontmatter(text)
      const hint = meta['argument-hint'] !== undefined && meta['argument-hint'] !== ''
        ? meta['argument-hint']
        : undefined
      const description = meta.description !== undefined && meta.description !== ''
        ? meta.description
        : `GSD Core workflow: ${base}`
      const definition: CommandDefinition = {
        name: `gsd-${base}`,
        description,
        ...(hint === undefined ? {} : { input: { hint } }),
        handler: async ({ agent, rawInput, signal }) => {
          try {
            const payload = await assemble(entry.name, rawInput, layout, config.includeBudgetChars, fs, signal)
            agent.steer(createUserMessage({
              content: [{ type: 'text', text: payload }],
              source: { kind: 'user' },
            }))
            return { kind: 'success', text: `/gsd-${base} dispatched — the GSD workflow now drives this session.` }
          } catch (error) {
            return { kind: 'error', text: `/gsd-${base} could not assemble its workflow: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      }
      try {
        disposers.push(ctx.commands.register(definition))
      } catch (error) {
        // Cross-layer duplicate (e.g. a restored dynamic bridge already
        // holding the same name): skip this command rather than fail the
        // boot. Same-layer duplicates still fail loud through the registry.
        ctx.logger.warn('gsd-bridge: /%s already registered elsewhere, skipped', definition.name)
        void error
      }
      count += 1
    }
    ctx.logger.info('gsd-bridge: registered %d /gsd-* commands from %s', count, layout.commandsDir)
  })()
}
