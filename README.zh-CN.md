# dsh-gsd-bridge

把 [GSD Core](https://github.com/open-gsd/gsd-core)——规范驱动开发系统（Git. Ship. Done.：Discuss → Plan → Execute → Verify → Ship）——挂载到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上，以原生 `/gsd-*` 斜杠命令的形式提供。

`@opengsd/gsd-core` 作为普通 npm 依赖被消费，并在**派发时**做内存适配；磁盘上的任何文件都永不改动。

## 特性

- **71 个工作流命令** —— 完整的 GSD Core 命令面成为 `/gsd-*` 斜杠命令：`/gsd-new-project`、`/gsd-onboard`、`/gsd-plan-phase`、`/gsd-execute-phase`、`/gsd-verify-work`、`/gsd-ship`、`/gsd-next`、`/gsd-help` …
- **会话定向** —— 当会话在含有 GSD 项目（`.planning/`）的目录中启动时，用当前 `STATE.md` 的头部对模型做定向，对应 GSD Core 的 `SessionStart` hook。
- **忠实上游、零 fork** —— 命令体在内存中适配（剥离 frontmatter、内联 `@~/.claude/gsd-core/...` 引用、改写工具词汇、重指向 `gsd_run` shim）。gsd-core 包本身从不改动，所以上游升级只是改一个版本号。
- **项目状态互通** —— GSD 状态活在项目里（`.planning/`），因此一个 Claude Code 会话和一个 DeepSeek Harness 会话可以交替驱动同一个项目。

## 环境要求

- Node.js ≥ 24
- 已挂载一个 DeepSeek Harness 的 `web`（或 base）profile——它必须提供 `fs` 与 `commands` 服务。

## 安装

直接从 GitHub 安装（无需 npm publish）。`prepare` 脚本会在安装时自动构建 `lib/`。

```bash
dsh plugin --profile web add github:cainiao1992/dsh-gsd-bridge --config.auto-install-peers=false
```

`dsh plugin` 会把参数原样转发给 profile 目录里的 pnpm。`--config.auto-install-peers=false` 用于绕开 `@deepseek-ai/dsh-*` 包 rc 期尚不完整的 peer 图——在 profile 场景中 peer 已由宿主 bundle 提供，无需重复安装。等价的手工形式：

```bash
cd ~/.dsh/profiles/web
corepack pnpm add github:cainiao1992/dsh-gsd-bridge --config.auto-install-peers=false
```

然后挂载：把本地绝对路径换成 bare 包名（loader 以配置文件目录为基准解析 bare 名 → profile 的 `node_modules`）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: gsd-bridge
      name: dsh-gsd-bridge
```

## 使用

在 DeepSeek Harness Web UI 里输入任意 `/gsd-*` 命令。

```text
/gsd-help            # 工作流目录
/gsd-new-project     # 新项目：提问 → 研究 → 需求 → 路线图
/gsd-onboard         # 存量代码库：建图 → 吸收文档 → 初始化 planning
/gsd-plan-phase 1    # 为阶段 1 创建详细计划
/gsd-execute-phase 1 # 执行该阶段的全部计划
/gsd-next            # 状态感知路由器
```

## 工作原理

每次 `/gsd-*` 派发都在命令到达模型之前于内存中适配：

| 适配 | 说明 |
|---|---|
| 剥离 frontmatter | 丢弃 `allowed-tools` / `requires` / `effort`（工具治理归 dsh 工具注册表）；取 `description`、`argument-hint` 注册命令。 |
| include 内联 | `@~/.claude/gsd-core/...` 的 `<execution_context>` 引用（Claude Code 在 prompt 组装期解析）被读取并内联，限额、防环、递归。 |
| 词汇改写 | `` `Read` ``→`` `read` ``、`Agent`→`subagent`、`AskUserQuestion`→`ask_user_question`、`/gsd:x`→`/gsd-x`、丢弃 Copilot 的 `<runtime_note>` 块。 |
| shim 重写 | `$(git rev-parse --show-toplevel …)` → 已安装包根，`gsd_run` / `gsd-tools.cjs` 即刻可用。 |
| 参数替换 | `$ARGUMENTS` / `${ARGUMENTS}` → 命令名之后的文本。 |

派发使用 `agent.steer()`（用户消息语义）；会话定向使用 `agent.inject()`（不唤醒 driver 的 notice）。

## Hook 覆盖

在 GSD Core 约 20 个 Claude Code hook 中，只移植了 `SessionStart` 状态定向（`agent/session-start` 事件 → `.planning/STATE.md` 注入）。工具拦截类 hook（`read-guard`、`worktree-path-guard` 等）由 dsh 原生权限/沙箱栈覆盖；更新检查类 hook 对固定 npm 依赖无意义。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `vendorRoot` | 已安装的 `@opengsd/gsd-core` | 要桥接的包根（fork 或本地检出） |
| `includeBudgetChars` | `220000` | 单命令 include 内联字符上限 |
| `stateCapChars` | `3500` | `STATE.md` 定向注入截断 |
| `orientation` | `true` | 关闭会话定向 |

`vendorRoot` 的推荐本地约定是 `~/.dsh/gsd-core`——一个包根安装（含 `commands/`、`agents/`，以及 `gsd-core/` 运行时根，即 `~/.claude/gsd-core` 的 DSH 对应物）：

```yaml
- id: gsd-bridge
  name: 'dsh-gsd-bridge'
  config:
    vendorRoot: /Users/<you>/.dsh/gsd-core
    includeBudgetChars: 100000
```

## 开发

```bash
npm install --legacy-peer-deps   # rc 期的 dsh npm peer 图对本地开发尚不完整
npm run build                    # tsc → lib/
```

类型契约来自已发布的 `@deepseek-ai/dsh-*` 声明（`dsh-commands`、`dsh-fs`、`dsh-agent`、`dsh-llm`）。

## 已知限制

- gsd-core 钉在 `1.12.0`；升级需重新验证命令体格式。
- dsh npm 包处于 rc 期；安装需 `--config.auto-install-peers=false`（上游 peer 图补全后可移除）。
- PreToolUse 类 hook 未移植（dsh 原生栈已覆盖）；`write-guard`（`.planning/` 灾难覆写防护）为已知缺口。
- GSD 命名 agent（`gsd-executor` 等）映射为 subagent + persona 文件提示，非原生 agent 类型。

## License

MIT（本仓库代码）。`@opengsd/gsd-core` 作为依赖以其自身 MIT 许可分发。
