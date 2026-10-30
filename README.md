# @local/dsh-chat-preset

ChatOnly 预设 + 它该有的请求形态，一个包管完。

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

## 配置

```yaml
- id: chatonly-context-policy
  name: '@local/dsh-chat-preset'
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
- **文件内容就是全部系统提示词**，不会自动拼 “You are an AI agent…” 之类的框架话

## 三个坑

1. **`complete: true` 会吞掉同作用域的其他段**——包括 `dsh-prompt-setting` 写的「我的 Prompt」。两者不能共存。
2. **同一作用域同名 section 只能注册一次**。不要在预设里再挂 `dsh-persona`。
3. **旧会话不追溯**。修复前落库的快照仍在；那类会话下次对话会多一条一次性 `Current runtime context: none.`，新会话没有。

关于第 1 条，`dsh-prompt-setting` 自己的实验文档也写了（`core/experiments.js` E3）：complete 段生效时，最终装配只剩它一个，监听器改写的顺序会被还原。

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

## 测试

```bash
node test.mjs    # 11 项：作用域隔离、预设判定、幂等、降级
```

不依赖任何第三方包，只用到 `node:` 内置模块，clone 下来直接能跑。

另有一套 17 项的集成测试，跑的是真实 `cordis` / `dsh-scope` / `dsh-system-prompt`（验证 `step()` 请求路径、工具剥离、`section` 热读）。它需要从 dsh 桌面端 `app.asar` 里抽出的 `@deepseek-ai/*`，**无法在仓库内独立运行**，因此不随仓库发布。
