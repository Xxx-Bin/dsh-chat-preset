# dsh-chat-preset

给 dsh 的 **ChatOnly** 预设打包的一整套实现：预设行本身，加上它应有的请求形态——没有运行时上下文快照、没有工具 schema、系统提示词从文件热读。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-plugin-4b5563.svg)](#前置要求)

---

## 目录

- [为什么需要它](#为什么需要它)
- [它做什么](#它做什么)
- [两个 role](#两个-role)
- [前置要求](#前置要求)
- [安装](#安装)
- [配置](#配置)
- [系统提示词](#系统提示词)
- [限制与冲突](#限制与冲突)
- [排查](#排查)
- [测试](#测试)
- [License](#license)

---

## 为什么需要它

dsh 的默认请求对「纯对话」这个场景是过重的。三件事会同时出现在每一条 ChatOnly 请求里：

1. **运行时上下文快照**——`dsh-working-directory` 把当前工作目录注入成一条 `runtime-context` 用户消息；
2. **全局工具 schema**——桌面端 bundle 注册的 `acp_*`、`sidebar_open`、`working_directory`、`search_context` 等，约 10 个工具对纯对话没有任何意义，却占着 prompt 预算；
3. **写死在预设里的系统提示词**——改一次要重启，没法边聊边调。

前两项**都不能在预设行里解决**：

- 上下文那项被注册成 `required: true`。预设的 `includeRuntimeContext: false` 走的是 `suppressRuntimeContext()`，它只移除 *可选* contribution，`refreshContext()` 仍会保留所有 `required === true` 的条目。
- 工具是**全局**收集的（`dsh-system-prompt/lib/index.js:364-365`），预设作用域只能加、不能删，也没有 `suppressTools()`。
- 连 `agent/pre-step` 里改写 decision 也没用：`dsh-agent-loop` 的 `step()` 会自己重算上下文并 append 到 surface，`decision.messages` 只用来判断*要不要*接纳它。

所以这个包换了一条路：**在 agent 作用域里用同名影子覆盖那个 contribution**，再从装配瀑布里把工具列表清空。详细推导和源码行号见 [`index.js`](./index.js) 头部注释。

## 它做什么

| 能力 | 做法 | 结果 |
|---|---|---|
| 拦截运行时上下文快照 | 在 **agent 作用域**用同名影子覆盖 `working-directory:current`（`required: false` + `text: ''`） | 请求与会话日志里都不出现 `Current runtime context` / 工作目录那句 |
| 剥离工具 | 钩 `system-prompt/assemble` 瀑布，清空 `assembly.tools` | 请求里连 `tools` 键都没有 |
| 系统提示词热读 | 占 `deployment:persona-prefix` 槽位（`complete: true`），`text` 是函数，每次装配读文件 | 改文件 → 下一条消息生效，免重启 |

前两项只对 `config.presetId`（默认 `chatonly`）生效，其他预设不受影响。

## 两个 role

同一个模块挂两次，靠 `config.role` 分流：

| role | 挂载位置 | 做什么 |
|---|---|---|
| `policy`（默认） | 全局 | 拦截上下文、剥离工具、注册 `/chatprompt` |
| `section` | 预设的 `plugins` 里 | 占 persona 槽位，从文件读系统提示词 |

## 前置要求

- **dsh**（桌面端或 CLI），`dsh plugin` 子命令可用
- **pnpm** 在 `PATH` 上——`dsh plugin add` 内部就是转发 `pnpm add`
- **Node.js ≥ 18**（ESM；`test.mjs` 用到顶层 `await`）

## 安装

dsh 把「把一个包装进 profile」做成了 **pnpm 转发 + 事后对账**，所以不用手改 `bundles`：

```bash
# 直接从 GitHub 装
dsh plugin --profile desktop add github:Xxx-Bin/dsh-chat-preset
```

```bash
# 或先克隆再 link（改代码即时生效，调试用这个）
git clone git@github.com:Xxx-Bin/dsh-chat-preset.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-chat-preset
```

`dsh plugin <profile> add` 会在 profile 目录里跑 `pnpm add`，然后对账 `dsh.profile.bundles`：凡是**已安装的依赖**且 **`package.json` 声明了 `dsh.bundle`** 的，自动追加进 layer stack。本包声明了 `dsh.bundle.patch`，所以加完依赖它自己就进 bundles 了。

重启 dsh，在预设选择里勾 **ChatOnly**。

<details>
<summary>手动安装（不依赖 dsh CLI）</summary>

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加
   `"dsh-chat-preset": "link:/absolute/path/to/dsh-chat-preset"`
2. 把它加进同文件的 `dsh.profile.bundles` 数组
3. 在该 profile 目录跑 `pnpm install`
4. 重启 dsh

</details>

装完先确认它真的加载了：看 `~/.dsh-filter-rtc-debug.log`，应该出现 `{"evt":"applied",...}` 和 `{"evt":"prompt-section",...}` 各一行。

## 配置

`cordis.patch.yml` 里的 `chatonly-context-policy` 行：

```yaml
- id: chatonly-context-policy
  name: 'dsh-chat-preset'
  config:
    role: 'policy'
    presetId: 'chatonly'                      # 目标预设 id
    contextName: 'working-directory:current'  # 要覆盖的 contribution 名
    stripTools: true                          # false = 保留工具
    file: '~/.dsh/chatonly-system-prompt.md'  # /chatprompt 的写入目标
```

## 系统提示词

- 文件：`~/.dsh/chatonly-system-prompt.md`（空文件 = 不发任何系统消息）
- 命令：`/chatprompt`（预览）· `/chatprompt show` · `/chatprompt clear` · `/chatprompt 正文…`
- **文件内容就是全部系统提示词**，不会自动拼 `You are an AI agent…` 之类的框架话

## 限制与冲突

**1. 没有上下文压缩**
本预设不挂压缩插件，没有自动压缩也不支持 `/compact`。对话一旦超出模型上下文窗口，**直接失败**，不会自动收缩。

**2. 与 `dsh-prompt-setting` 的「我的 Prompt」互斥**
`complete: true` 会吞掉同作用域的其他段。两者不能共存。`dsh-prompt-setting` 自己的实验文档也写了这一点（`core/experiments.js` E3）：complete 段生效时，最终装配只剩它一个，监听器改写的顺序会被还原。

**3. 一个作用域内同名 section 只能注册一次**
不要在预设里再挂 `dsh-persona`，会撞名抛错。

**4. 旧会话不追溯**
修复前落库的快照仍在。那类会话下次对话会多一条一次性 `Current runtime context: none.`，新会话没有。

## 排查

`~/.dsh-filter-rtc-debug.log`，一行一个 JSON：

| 事件 | 含义 |
|---|---|
| `applied` | 插件加载（`stripTools` 值一并记下） |
| `suppress` | 影子已在 agent 作用域注册 |
| `strip-tools` | 本次装配剥掉了 N 个工具（带名字） |
| `prompt-section` | section 注册成功，带文件路径与当前字数 |
| `miss` / `error` | 能力缺失或异常（带 `stage`） |

会话侧要看**解压后**的日志（会话文件是 11 帧拼接的 zstd，普通解压只读得到 header）。

### Windows：`ERR_PNPM_EPERM ... rename '<name>_tmp_N_M' -> '<name>'`

在同一个 profile 上**反复切换同一个包的数据源**（`link:` ↔ `github:` ↔ 版本号）时会撞到：

```
[ERR_PNPM_EPERM] [importPackage ...node_modules\dsh-chat-preset]
EPERM: operation not permitted, rename '...\dsh-chat-preset_tmp_15912_4' -> '...\dsh-chat-preset'
```

原因是 Windows 的 `MoveFileEx` **不能** rename 覆盖一个已存在的目录（空目录也不行），而 POSIX 允许——
所以这个错几乎只在 Windows 上出现。pnpm 的 import 是「临时目录 → rename」，目标还在就卡死。

绕过：**先把目标条目摘掉，再执行 add。**

```powershell
# 摘链。只删链接本身，不会动到链接指向的仓库
(Get-Item 'C:\Users\<you>\.dsh\profiles\<profile>\node_modules\<pkg>' -Force).Delete()
```

> ⚠️ 别用 `rm -rf` 删这个条目。它是指向源码目录的 reparse point，`rm -rf` 会**跟进目标**把仓库删掉。

然后正常 `dsh plugin --profile <p> add <spec>` 即可。

## 测试

```bash
node test.mjs    # 11 项：作用域隔离、预设判定、幂等、降级
```

不依赖任何第三方包，只用到 `node:` 内置模块，clone 下来直接能跑。

另有一套 17 项的集成测试，跑的是真实 `cordis` / `dsh-scope` / `dsh-system-prompt`（验证 `step()` 请求路径、工具剥离、`section` 热读）。它需要从 dsh 桌面端 `app.asar` 里抽出的 `@deepseek-ai/*`，**无法在仓库内独立运行**，因此不随仓库发布。

## License

[MIT](./LICENSE)
