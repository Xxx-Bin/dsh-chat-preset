# dsh-chat-preset

给 dsh 的 **ChatOnly** 预设打包的整套实现：预设行本身，加上它应有的请求形态——没有运行时上下文快照、没有工具 schema、系统提示词从文件热读。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-plugin-4b5563.svg)](#前置要求)

## 它解决什么

dsh 的默认请求对「纯对话」这个场景是过重的。三样东西会同时出现在每一条 ChatOnly 请求里：

1. **运行时上下文快照**——`dsh-working-directory` 把当前工作目录注入成一条 `runtime-context` 用户消息；
2. **全局工具 schema**——桌面端插件注入的 `acp_*`、`compress`、`search_context`、`working_directory`，对纯对话没有意义，却占着 prompt 预算；
3. **写死在预设里的系统提示词**——改一次要重启，没法边聊边调。

前两项**都不能在预设行里解决**：

- 上下文那项被注册成 `required: true`。预设的 `includeRuntimeContext: false` 走的是 `suppressRuntimeContext()`，它只移除*可选* contribution。
- 工具是**全局**收集的，预设作用域只能加、不能删，也没有 `suppressTools()`。
- 连 `agent/pre-step` 里改写 decision 也没用：`dsh-agent-loop` 的 `step()` 会自己重算上下文并 append 到 surface。

所以这个包换了一条路：**在 agent 作用域里用同名影子覆盖那个 contribution**，再从装配瀑布里把工具列表清空。推导与源码行号见 [`index.js`](./index.js) 头部注释。

## 它做什么

| 能力 | 做法 | 结果 |
|---|---|---|
| 拦截运行时上下文快照 | 在 **agent 作用域**用同名影子覆盖 `working-directory:current`（`required: false` + `text: ''`） | 请求与会话日志里都不出现 `Current runtime context` / 工作目录那句 |
| 剥离工具 | 钩 `system-prompt/assemble` 瀑布，清空 `assembly.tools` | 请求里连 `tools` 键都没有 |
| 系统提示词热读 | 占 `deployment:persona-prefix` 槽位（`complete: true`），`text` 是函数，每次装配读文件 | 改文件 → 下一条消息生效，免重启 |

前两项只对 `config.presetId`（默认 `chatonly`）生效，其他预设不受影响。

## 前置要求

- **dsh**（桌面端或 CLI），`dsh plugin` 子命令可用
- **pnpm** 在 `PATH` 上——`dsh plugin add` 内部就是转发 `pnpm add`
- **Node.js ≥ 18**（ESM；`test.mjs` 用到顶层 `await`）

## 安装

```bash
# 从 npm 装（推荐）
dsh plugin --profile desktop add dsh-chat-preset

# 或从 GitHub 装
dsh plugin --profile desktop add github:Xxx-Bin/dsh-chat-preset

# 本地开发：装路径，改代码即时生效
git clone git@github.com:Xxx-Bin/dsh-chat-preset.git
dsh plugin --profile desktop add /absolute/path/to/dsh-chat-preset
```

`--profile` 后面是 **profile 名**，即 `~/.dsh/profiles/` 下的目录名。桌面端默认叫 `desktop`；不确定就先 `ls ~/.dsh/profiles` 看一眼。

`dsh plugin --profile desktop add` 会在该 profile 目录里跑 `pnpm add`，然后对账 `dsh.profile.bundles`：凡是**已安装的依赖**且 **`package.json` 声明了 `dsh.bundle`** 的，自动追加进 layer stack。本包声明了 `dsh.bundle.patch`，所以加完依赖它自己就进 bundles 了。

**装完必须重启 dsh**——bundles 层只在启动时合成，运行中不监听。重启后在预设选择里勾 **ChatOnly**。

<details>
<summary>手动安装（不依赖 dsh CLI）</summary>

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加
   `"dsh-chat-preset": "link:/absolute/path/to/dsh-chat-preset"`
2. 把它加进同文件的 `dsh.profile.bundles` 数组
3. 在该 profile 目录跑 `pnpm install`
4. 重启 dsh

</details>

## 确认生效

装了没反应，先按这三条查，不用猜。下面用 `desktop` 举例，换 profile 就改这个名字：

```bash
# 1. 依赖和 bundles 里都该有它（输出形如：^1.1.1 true）
node -e "const p=require(require('os').homedir()+'/.dsh/profiles/desktop/package.json');console.log(p.dependencies['dsh-chat-preset'], p.dsh.profile.bundles.includes('dsh-chat-preset'))"

# 2. 合成树里应出现两行（policy + section）
dsh --profile desktop --dump-config | grep -A2 dsh-chat-preset

# 3. 重启 dsh —— bundles 只在启动时合成，运行中不监听
```

第 2 条正确的话会长这样：

```yaml
# == dsh-chat-preset
- id: chatonly-context-policy
  name: dsh-chat-preset
- id: preset-chat
```

## 用法

### 系统提示词

在对话框里用 `/chatprompt` 就能注入、查看、清空，不用去翻文件：

| 命令 | 作用 |
|---|---|
| `/chatprompt 你是一个……` | **注入**——写入文件并立即生效（下一条消息） |
| `/chatprompt` | **查看**——当前内容预览、字数、文件路径 |
| `/chatprompt show` | 查看全文 |
| `/chatprompt clear` | **清空**——之后不再发送任何系统消息 |

内容存在 `~/.dsh/chatonly-system-prompt.md`，命令只是它的读写入口，你也可以直接编辑该文件。空文件 = 不发系统消息。

**文件内容就是全部系统提示词**，不会自动拼 `You are an AI agent…` 之类的框架话。

### 配置

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

### 两个 role

同一个模块挂两次，靠 `config.role` 分流：

| role | 挂载位置 | 做什么 |
|---|---|---|
| `policy`（默认） | 全局 | 拦截上下文、剥离工具、注册 `/chatprompt` |
| `section` | 预设的 `plugins` 里 | 占 persona 槽位，从文件读系统提示词 |

## 限制与冲突

**1. 没有上下文压缩**
本预设不挂压缩插件，没有自动压缩也不支持 `/compact`。对话一旦超出模型上下文窗口，**直接失败**，不会自动收缩。

**2. 与 `dsh-prompt-setting` 的「我的 Prompt」互斥**
`complete: true` 会吞掉同作用域的其他段。两者不能共存。`dsh-prompt-setting` 自己的实验文档也写了这一点（`core/experiments.js` E3）：complete 段生效时，最终装配只剩它一个，监听器改写的顺序会被还原。

**3. 一个作用域内同名 section 只能注册一次**
不要在预设里再挂 `dsh-persona`，会撞名抛错。

**4. 旧会话不追溯**
修复前落库的快照仍在。那类会话下次对话会多一条一次性 `Current runtime context: none.`，新会话没有。

## 测试

```bash
node test.mjs    # 11 项：作用域隔离、预设判定、幂等、降级
```

不依赖任何第三方包，只用到 `node:` 内置模块，clone 下来直接能跑。

## License

[MIT](./LICENSE)
