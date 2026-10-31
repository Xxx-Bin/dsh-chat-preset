# dsh-chat-preset

> ChatOnly —— 本项目提供的预设 agent。抑制工具注入与工作目录注入，使请求仅包含用户输入，以及可选的自定义系统提示词。

[![CI](https://github.com/Xxx-Bin/dsh-chat-preset/actions/workflows/ci.yml/badge.svg)](https://github.com/Xxx-Bin/dsh-chat-preset/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-chat-preset.svg)](https://www.npmjs.com/package/dsh-chat-preset)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)](https://nodejs.org)

> **安装前须知。** 本包不依赖公开插件 API，其行为由 DSH 的三处内部语义决定（作用域同名 shadow 覆盖、`system-prompt/assemble` 瀑布、`refreshContext()` 的合并顺序）。上述语义变更时，本包会**静默失效**：不报错、不崩溃，仅退回默认请求形态。详见[兼容性与脆弱性](#兼容性与脆弱性)。

---

## 概述

DSH 默认的最小配置是精简模式。即便在该模式下，请求仍包含两类注入，且均无法在预设配置层消除：

1. **工具 schema。** 工具在全局层收集，与预设作用域无关，预设只能追加、不能移除。
2. **工作目录消息。** DSH 默认在用户输入之后追发一条 `runtime-context` 用户消息，内容为当前工作目录 `Current working directory: C:\…`；该 contribution 以 `required: true` 注册，`includeRuntimeContext: false` 只过滤可选 contribution。

本包提供 ChatOnly 预设 agent，在装配瀑布与 context 注册层分别消除这两类注入，并将系统提示词改为文件热更新，用于受控条件下的模型能力评测。

## 请求形态

测量环境：DSH 桌面端，`desktop` profile。

```diff
  # 抑制前
- tools:    9 个 — acp_cache, acp_read_original_image, acp_status, compress,
-                 decompress, external_plugins, load_workspace_dependencies,
-                 search_context, working_directory
- messages: [ …, { source: { kind: "runtime-context" } } ]
-                 # 用户输入之后追发的工作目录消息
  # 抑制后
+ tools:    该键不存在
+ messages: 仅用户输入
```

工具数量随已安装插件变化，本机观测区间为 **8–14 个**。

## 预设层的限制

| 目标 | 预设层的限制 |
|---|---|
| 移除工作目录消息 | 该 contribution 注册为 `required: true`；`suppressRuntimeContext()` 仅过滤可选项 |
| 移除全局工具 schema | 工具在全局层收集，预设作用域只可追加；不存在 `suppressTools()` |
| 改写 `agent/pre-step` 决策 | `dsh-agent-loop` 的 `step()` 会重新计算上下文并写入 surface，从 decision 中移除消息只会使其在 fallback 分支重建 |

本包因此改由三处机制实现：agent 作用域内的同名空 shadow、`system-prompt/assemble` 瀑布、以及 `buildRequest()` 在工具列表为空时省略该键的行为。推导过程与源码行号见 [`index.js`](./index.js) 头部注释。

## 安装

依赖：**dsh**（桌面端或 CLI）、`pnpm` 位于 `PATH`（`dsh plugin add` 内部转发 `pnpm add`）、**Node.js ≥ 18**。

```bash
# npm
dsh plugin --profile desktop add dsh-chat-preset

# GitHub
dsh plugin --profile desktop add github:Xxx-Bin/dsh-chat-preset

# 本地路径（修改代码后需重启 dsh，模块存在缓存）
git clone git@github.com:Xxx-Bin/dsh-chat-preset.git
dsh plugin --profile desktop add /absolute/path/to/dsh-chat-preset
```

`--profile` 为 profile 名，即 `~/.dsh/profiles/` 下的目录名；桌面端默认为 `desktop`。`add` 在该目录执行 `pnpm add`，随后核对 `dsh.profile.bundles`：凡已安装且 `package.json` 声明 `dsh.bundle` 的依赖会被追加进 layer stack。本包声明 `dsh.bundle.patch`，安装后自动登记。

**安装后须重启 dsh。** bundles 层仅在启动时合成，运行期不监听变更。重启后在预设选择中启用 **ChatOnly**。

<details>
<summary>手动安装（不依赖 dsh CLI）</summary>

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中添加 `"dsh-chat-preset": "link:/absolute/path/to/dsh-chat-preset"`
2. 在同一文件的 `dsh.profile.bundles` 数组中添加 `"dsh-chat-preset"`
3. 在该目录执行 `pnpm install`
4. 重启 dsh

</details>

## 使用

### 系统提示词：`/chatprompt`

提示词存于 `~/.dsh/chatonly-system-prompt.md`，命令仅作为读写入口，亦可直接编辑文件。

| 命令 | 行为 |
|---|---|
| `/chatprompt <text>` | 写入文件，下一条消息生效 |
| `/chatprompt` | 输出预览、字符数与文件路径 |
| `/chatprompt show` | 输出全文 |
| `/chatprompt clear` | 清空文件；此后不发送系统提示词 |

文件为空时不发送任何系统消息，请求中仅含用户输入。`deployment:persona-prefix` 段由本包以 `complete: true` 独占，不再拼接部署层其它文本。

> 该命令全局注册，可在任意预设下调用，但仅影响 ChatOnly；在其它预设下修改不会生效，亦无提示。

### 工具抑制开关：`/chattools`

默认抑制，即请求不携带任何工具 schema。

| 命令 | 行为 |
|---|---|
| `/chattools` 或 `/chattools status` | 输出当前模式与状态文件路径 |
| `/chattools on` | 抑制工具注入 |
| `/chattools off` | 放行，`assembly.tools` 原样传递 |
| `/chattools reset` | 删除状态文件，回退出厂默认 |

状态存于 `~/.dsh/chatonly-strip-tools.state`，内容为 `strip` 或 `pass`。每次装配重新读取，切换后下一条消息生效；文件不存在时采用 `config.stripTools`。参数接受 `on`／`strip`／`intercept`／`block`／`true`／`1` 与 `off`／`pass`／`allow`／`bypass`／`false`／`0` 两组同义词，无法识别时返回错误且不改变状态。

放行状态下，本包原样返回下游装配结果，其它插件的工具追加与过滤逻辑均按原有顺序生效。本包不提供工具，仅在抑制状态下清空列表。

> 该命令全局注册且作用于所有 ChatOnly 会话：状态是单一文件，不按会话或 agent 区分。

#### 两种抑制相互独立

`/chattools off` 仅放行工具。`working-directory:current` 在该会话中仍为空，模型不获得工作目录及其它环境信息。

若启用文件类工具而未提供工作目录，模型缺少定位依据，评测结果将混入环境缺失的影响。因此放行工具时应同时满足两项条件：

1. 通过 `dsh-tool-manager` 等插件将工具集限制为本次评测所需的最小集合。全局注入的 8–14 个工具签名不属于评测变量。
2. 在系统提示词中补充工作目录与环境约束。抑制状态下，该文件是唯一的环境信息来源。

### 配置

`cordis.patch.yml` 以 `config.role` 分流两处挂载：

| role | 挂载位置 | 职责 |
|---|---|---|
| `policy`（默认） | 全局 | 抑制工作目录注入、按开关抑制工具、注册 `/chatprompt` 与 `/chattools` |
| `section` | ChatOnly 预设 agent 的 `plugins` | 占用 persona 槽位，从文件读取系统提示词 |

```yaml
- insert:
    # 行 1：全局挂载（policy）
    - id: chatonly-context-policy
      name: 'dsh-chat-preset'
      config:
        role: 'policy'
        presetId: 'chatonly'                      # 须与预设行的 config.id 一致
        contextName: 'working-directory:current'  # 被覆盖的 contribution 名
        stripTools: true                          # 出厂默认；运行期由 /chattools 切换
        toolsStateFile: '~/.dsh/chatonly-strip-tools.state'
        file: '~/.dsh/chatonly-system-prompt.md'  # /chatprompt 写入目标

    # 行 2：定义预设 ChatOnly，并在其 plugins 内挂载 section
    - id: preset-chat
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: chatonly
        name: ChatOnly
        order: 5
        plugins:
          - id: prompt
            name: 'dsh-chat-preset'
            config:
              role: 'section'
              file: '~/.dsh/chatonly-system-prompt.md'  # 装配读取来源
```

**`presetId` 必须与预设行的 `config.id` 一致。** 两者不同时，`policy` 行不会作用于该预设，注入照常存在。

**两处 `file` 必须一致。** 写入与读取路径不同时，`/chatprompt` 会报告保存成功而系统提示词从未生效。

**`toolsStateFile` 不得与 `file` 指向同一路径。** 开关文件按单行关键字解析，读到提示词全文时识别失败并永久回退出厂默认；反向更糟，`/chattools on|off` 会把提示词覆盖成一行 `strip`／`pass`。

**`stripTools` 是出厂默认值，不是总开关。** 状态文件存在时以其为准；设为 `false` 不会禁用 `/chattools`，仅改变未切换时的默认行为。需要彻底禁用抑制行为时应卸载本包。

## 兼容性与脆弱性

本包依赖三处非公开行为：

| 依赖 | 失效后果 |
|---|---|
| agent 作用域同名 context 覆盖全局同名 context | shadow 不生效，工作目录消息恢复 |
| `required: false` + `text: ''` 使 contribution 被过滤、投影返回 `undefined` | 空字符串被视为内容，请求中多出一条空 `runtime-context` |
| `buildRequest()` 在 `tools` 为空时省略该键 | 该键变为 `tools: []`，多数模型 API 会拒绝 |

失效时无报错、无异常，仅退回默认形态。升级 dsh 后应依次确认：bundles 仍然登记（见[排障](#确认生效)第 1 条）；新建 ChatOnly 会话的请求中不存在 `tools` 键。

开发与测量环境为 DSH 桌面端 `desktop` profile；CLI profile 原理相同，未逐项验证。

## 限制

1. **无上下文压缩。** 未挂载压缩插件，不支持自动压缩与 `/compact`。对话超出模型上下文窗口时请求直接失败。
2. **与 `dsh-prompt-setting` 的「我的 Prompt」互斥。** `complete: true` 会覆盖同作用域内的其它段（参见该项目 `core/experiments.js` E3），两者不可共存。
3. **同一作用域内同名 section 只能注册一次。** 预设内不应再挂载 `dsh-persona`，否则抛错。
4. **会话内切换预设不撤销工作目录抑制。** shadow 在 agent 作用域一次性注册且无卸载路径。由 ChatOnly 切换至其它预设后，该会话的 `working-directory:current` 仍为空，直至新建会话。
5. **旧会话不追溯。** 修复前已落库的工作目录消息仍然存在；此类会话下次对话会多出一条一次性的 `Current runtime context: none.`。
6. **工具开关为全局状态。** 其值为单一文件，`/chattools off` 对所有已打开的 ChatOnly 会话同时生效。工作目录抑制则按 agent 注册且不可撤销。两者机制不同，行为不对称。

## 卸载与清理

```bash
# 1. 从 profile 移除：dependencies 与 dsh.profile.bundles 各删除一条
#    ~/.dsh/profiles/desktop/package.json
#    随后在该目录执行 pnpm install 并重启 dsh

# 2. 系统提示词文件（用户内容，按需保留）
rm ~/.dsh/chatonly-system-prompt.md

# 3. 工具开关状态
rm ~/.dsh/chatonly-strip-tools.state

# 4. 调试日志
rm ~/.dsh-filter-rtc-debug.log
```

`dsh plugin remove`（或桌面端插件页的卸载）**不会**动上面第 2–4 项。它的流程是：从 `dsh.profile.bundles` 摘除 → 卸载运行期 contribution → `pnpm remove` → 重新解析。插件 API 没有卸载钩子，流程也不扫描插件写过哪些文件，因此这几步只能手动执行。

不清理不算残留故障：卸载会 dispose 全部运行期注册（命令、section、监听器、shadow），行为当场回到默认；上述文件此后无人读取，只是留在主目录。唯一的真实影响是**重装沿用旧开关** —— `chatonly-strip-tools.state` 仍在时 `/chattools` 不回出厂默认，而是上次写入的 `strip`／`pass`；要拿到干净初值，先执行 `/chattools reset`。

Windows 下 `rm` 不可用：PowerShell 用 `Remove-Item`，cmd 用 `del`。

### 调试日志

`index.js` 向 `~/.dsh-filter-rtc-debug.log` 同步追加 JSON 行，记录每次装配、每次工具剥离、每次模式切换与每次 shadow 注册。日志无大小上限与轮转机制，长期使用会持续增长。

`{"evt":"strip-tools","count":9,...}` 为抑制生效的记录，可按 `sessionId` 核对具体会话。该日志为调试期脚手架，删除后会在下次触发时重建。

## 确认生效

按序检查，用 `desktop` 举例：

```bash
# 1. 依赖与 bundles 登记状态（可同时区分"未安装"与"已安装未登记"）
node -e "const os=require('os'),fs=require('fs');const f=os.homedir()+'/.dsh/profiles/desktop/package.json';if(!fs.existsSync(f)){console.log('profile 不存在: '+f);process.exit(0)}const p=JSON.parse(fs.readFileSync(f,'utf8'));console.log('dep    :',p.dependencies?.['dsh-chat-preset']??'<未安装>');const b=p.dsh?.profile?.bundles;console.log('bundles:',Array.isArray(b)?(b.includes('dsh-chat-preset')?'已登记':'未登记'):'<无此字段>')"

# 2. 依赖树中存在该包（应输出 dsh-chat-preset@<版本>）

#    Linux / macOS
dsh plugin --profile desktop ls | grep dsh-chat-preset

#    Windows（PowerShell，无 grep）
dsh plugin --profile desktop ls | Select-String dsh-chat-preset
#    Windows（cmd，无 grep）
dsh plugin --profile desktop ls | findstr dsh-chat-preset

# 3. 重启 dsh —— bundles 层仅在启动时合成
```

前两步仅确认安装状态，第三步之后才涉及生效。Windows 用户以 git-bash 执行时可沿用 `grep` 写法。

| 第 1 步输出 | 结论 |
|---|---|
| `dep: <未安装>` | 依赖未写入，重新安装 |
| `dep: ^1.2.0` + `bundles: 未登记` | 已安装但未进入 layer stack，手动补充 `dsh.profile.bundles` |
| 两项均正常，但 ChatOnly 不在预设列表 | 未重启，或重启的 profile 不符 |

> `dsh --profile desktop --dump-config` 会报 *profile "desktop" is managed exclusively by the Electron application*。桌面端 profile 不允许 CLI 渲染配置树；如需检查合成结果，可在 CLI 管理的 profile（`web` / `headless`）中安装一次。

## 开发

```bash
node test.mjs
```

25 项测试，全部通过。基于 `@deepseek-ai/dsh-system-prompt` 与 `agent-loop step()` 的等价模型，覆盖作用域隔离、预设判定、幂等性、能力缺失时的降级、工具瀑布的两种模式（抑制清空／放行后其它插件的增删可见）以及 `/chattools` 的切换语义。仅依赖 `node:` 内置模块。

测试使用等价装配模型而非 DSH 本体；真实链路仍以新建 ChatOnly 会话检查请求为准。

CI 在 Node 18／20／22 上运行同一套测试（`.github/workflows/ci.yml`）。

## 发布

推版本标签即触发 npm 发布（`.github/workflows/publish.yml`）：

```bash
npm version patch            # 或 minor / major，同时打 tag（如 v1.2.0）
git push --follow-tags
```

工作流依次执行：测试 → 校验 tag 与 `package.json` 版本一致 → `npm publish --access public`。版本不一致或测试失败时不会发布。

前置条件：仓库 Secrets 中存在 `NPM_TOKEN`，且必须是 npm 的 **Automation** 类型令牌。Publish 类型令牌仍会要求 OTP，在 CI 中必然失败（EOTP）。

> 本机 `~/.npmrc` 若将 registry 指向镜像（如 `registry.npmmirror.com`），手动发布需显式指定 `--registry https://registry.npmjs.org`；工作流的 `setup-node` 已固定为官方源。

## License

[MIT](./LICENSE)
