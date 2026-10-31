/**
 * chat-preset — the ChatOnly preset row PLUS the context policy that belongs
 * to it (merged from the former `@local/dsh-filter-runtime-context` package:
 * one package, one place to look when ChatOnly's request looks wrong).
 *
 * Keeps the loop-owned runtime-context snapshot out of the model request for
 * agents owned by ONE preset (default: the local `chatonly` preset), and drops
 * the globally registered tool schemas for that preset.
 *
 * Why the obvious approach does NOT work
 * -------------------------------------
 * Rewriting the `agent/pre-step` waterfall decision (`{ ...decision, messages }`
 * without the snapshot) has no effect, neither on the request nor on the
 * committed session log. `dsh-agent-loop`'s `step()` recomputes the context
 * itself and re-admits it:
 *
 *   const sections = renderContextSections(
 *     this.loopCtx.systemPrompt.refreshContext(assembly, assembleContextFor(this, signal)));
 *   const context = this.runtimeContext.project(joinContextSections(sections), sections);
 *   ...
 *   if (firstAttempt) for (const message of decision.messages)
 *     if (message.source.kind === 'runtime-context') { ... sets contextAdmitted only ... }
 *   if (context !== void 0 && !contextAdmitted)
 *     this.session.append('user/message', context, { surfaceOp: 'append' });   // <-- always
 *
 * `decision.messages` is consulted solely to decide *whether* to admit the
 * freshly projected context — dropping the message from that list only makes
 * the admission happen on the fallback line, with identical text. Evidence on
 * this machine: all 9 chatonly sessions that ran the previous version still
 * carry a `source.kind === 'runtime-context'` user message on the surface.
 *
 * Why the preset cannot remove it either
 * -------------------------------------
 * `@deepseek-ai/dsh-working-directory` registers its contribution as
 * `required: true`. Suppression (`systemPrompt.suppressRuntimeContext()`, which
 * is what the chatonly preset's `includeRuntimeContext: false` does) removes
 * only optional contributions, and `refreshContext()` keeps every
 * `required === true` entry regardless.
 *
 * The lever that works
 * --------------------
 * Register a scoped shadow of that contribution under the SAME name in the
 * agent's own scope (`agent.ctx`, scope key = the agent — see
 * `assembleContextFor` in `dsh-agent`: `{ scope: agent }`). Scoped named entries
 * shadow global ones in both `assemble()` and `refreshContext()`, so the shadow
 * wins the name:
 *
 *   - `required: false` drops it from the suppression-filtered assembly, and
 *   - `text: ''` renders to nothing, so `renderContextSections()` filters it out,
 *     `joinContextSections()` yields `''`, and `RuntimeContextProjection.project()`
 *     returns `undefined` (fresh session) — nothing is appended to the surface
 *     and nothing reaches the request.
 *
 * Registration is owned by the agent scope fiber, so it is disposed with the
 * agent; one registration per agent is enforced locally because a duplicate
 * name inside one layer throws.
 *
 * Caveat: for a session that already committed a snapshot under an older
 * version, `RuntimeContextProjection.project()` first emits its one-shot
 * `Current runtime context: none.` marker (retained -> CLEARED). New chatonly
 * sessions never see it.
 *
 * Tools (switch: `/chattools`, factory default = intercept)
 * ---------------------------------------------------------
 * A preset row cannot remove tools: `assemble()` collects every GLOBAL tool
 * provider unconditionally (`dsh-system-prompt`:364-365) and there is no
 * `suppressTools()` counterpart to `suppressRuntimeContext()`. With tools
 * registered by the desktop bundles (acp_*, sidebar_open, working_directory,
 * search_context, …) a ChatOnly request therefore still carried 10 tool
 * schemas. The assembly waterfall fixes it: `buildRequest(…, assembly.tools, …)`
 * emits `{ tools }` only when the list is non-empty (`dsh-agent-loop`:1217-1220),
 * so clearing `assembly.tools` means the model is offered no tools at all.
 *
 * Interception is a live switch, not a build-time config:
 *   - `~/.dsh/chatonly-strip-tools.state` — one word (`strip` / `pass`), read on
 *     every assembly and written by `/chattools on|off`. Missing = the factory
 *     default, `config.stripTools` (true).
 *   - With the switch OFF the listener returns the downstream assembly verbatim,
 *     so any other plugin's tool provider or filter behaves exactly as it would
 *     without this package installed. That is the "let someone else manage it"
 *     mode — this package never adds tools of its own, it only clears the list.
 *   - `config.stripTools: false` therefore means "ship turned off", not "toggle
 *     disabled": `/chattools on` can still turn interception on later.
 *
 * @module dsh-chat-preset
 */

// --- self-diagnostics: one JSON line per install/miss into ~/.dsh-filter-rtc-debug.log ---
// (temporary; delete dbg() and this block once the filter is verified in the app)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DBG_PATH = `${os.homedir()}/.dsh-filter-rtc-debug.log`;
function dbg(obj) {
  // Read lazily: tests import this module (which runs before their own statements)
  // and set DSH_FILTER_RTC_DEBUG=0 to keep their runs out of the app's log.
  if (process.env.DSH_FILTER_RTC_DEBUG === '0') return;
  try {
    fs.appendFileSync(DBG_PATH, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
  } catch {
    /* diagnostics must never break the loop */
  }
}

export const name = 'chat-preset';

/**
 * Cordis resolves a service on a context only for fibers that declare it.
 * Without this the plugin's own `ctx.sessionProjections` throws
 * `cannot get property "sessionProjections" without inject` — which is exactly
 * what the first live run produced (evt:"error" in the debug log).
 */
export const inject = ['sessionProjections', 'systemPrompt', 'commands'];

const DEFAULT_PRESET_ID = 'chatonly';
/**
 * The tool-interception switch. One line of text; absent/empty = factory default
 * (`config.stripTools`, itself defaulting to true). Read on every assembly, so
 * `/chattools off` applies to the next message — no restart.
 */
const DEFAULT_TOOLS_STATE_FILE = '~/.dsh/chatonly-strip-tools.state';
/** Accepted spellings in the state file / `/chattools` argument. */
const SWITCH_ON = new Set(['on', 'strip', 'intercept', 'block', 'true', '1']);
const SWITCH_OFF = new Set(['off', 'pass', 'allow', 'bypass', 'false', '0']);
/** The working-directory contribution owned by `dsh-working-directory`. */
const DEFAULT_CONTEXT_NAME = 'working-directory:current';
/** Fallback placement = `CONTEXT_ORDERS.WORKING_DIRECTORY` in `dsh-system-prompt`. */
const DEFAULT_CONTEXT_ORDER = 100;
/** Where the ChatOnly system prompt lives (role `section`). */
const DEFAULT_PROMPT_FILE = '~/.dsh/chatonly-system-prompt.md';
/** Section names owned by `dsh-system-prompt` / `dsh-persona`. */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';
const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix';

function applyPolicy(ctx, config = {}) {
  const presetId = config.presetId ?? DEFAULT_PRESET_ID;
  const contextName = config.contextName ?? DEFAULT_CONTEXT_NAME;
  const toolsStateFile = expandHome(config.toolsStateFile ?? DEFAULT_TOOLS_STATE_FILE);
  /** Factory default for the switch; the state file (see `/chattools`) overrides it. */
  const stripToolsDefault = config.stripTools ?? true;
  /** Agents whose shadow contribution is already installed (per agent, never reused). */
  const installed = new WeakSet();
  /** Last observed switch value, so diagnostics fire on flips instead of per step. */
  let lastStrip;

  const stripToolsNow = () => readSwitch(toolsStateFile, stripToolsDefault);

  dbg({ evt: 'applied', presetId, contextName, stripTools: stripToolsNow(), toolsStateFile, pid: process.pid });

  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload?.agent;
    if (agent === undefined || agent === null) return next();

    // 1) Only the owning preset is touched; every other agent passes through.
    //    A diagnostic or capability failure must never break the loop, so every
    //    step below is defensive and the decision is always handed back as-is.
    try {
      if (readPresetId(ctx, agent) === presetId) {
        // 2) Shadow the required contribution before `step()` refreshes it.
        suppress(agent, contextName, installed);
      }
    } catch (error) {
      dbg({ evt: 'error', message: String(error), sessionId: agent?.session?.id ?? null });
    }

    // 3) The decision is returned untouched: the snapshot is not a message we
    //    can filter, it is a projection `step()` recomputes (see header).
    return next();
  });

  // --- tools -----------------------------------------------------------------
  // `assemble()` collects every GLOBAL tool provider unconditionally
  // (dsh-system-prompt/lib/index.js:365) and a preset's scoped layer can only
  // add, never remove — so a preset row cannot drop tools. The assembly
  // waterfall is the one place that can: `buildRequest(..., assembly.tools, ...)`
  // omits `tools` entirely when the list is empty.
  //
  // The listener is ALWAYS registered, even when the switch is off: that is what
  // makes `/chattools off|on` a live toggle. With the switch off the assembly is
  // returned verbatim, so every other plugin's tool provider / filter keeps
  // working exactly as it would without this package.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next();
    try {
      const agent = context?.agent;
      if (agent === undefined || agent === null) return out;
      if (readPresetId(ctx, agent) !== presetId) return out;

      const strip = stripToolsNow();
      if (strip !== lastStrip) {
        lastStrip = strip;
        dbg({ evt: 'tools-mode', strip, file: toolsStateFile, sessionId: agent?.session?.id ?? null });
      }
      if (!strip) return out; // pass-through: other plugins own the tool list

      const tools = out?.tools;
      if (!Array.isArray(tools) || tools.length === 0) return out;
      dbg({
        evt: 'strip-tools',
        count: tools.length,
        names: tools.map((tool) => tool?.name).slice(0, 20),
        sessionId: agent?.session?.id ?? null,
      });
      return { ...out, tools: [] };
    } catch (error) {
      dbg({ evt: 'error', stage: 'strip-tools', message: String(error) });
      return out;
    }
  });

  registerToolsCommand(ctx, toolsStateFile, stripToolsDefault);
  registerCommand(ctx, config.file ?? DEFAULT_PROMPT_FILE);
}

// --- the tool switch ---------------------------------------------------------

/** Last unrecognized state value already reported, per file. */
const complained = new Map();

/** The persisted switch, falling back to the factory default. Never throws. */
function readSwitch(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim().toLowerCase();
  } catch {
    return fallback; // missing file = never toggled
  }
  if (raw.length === 0) return fallback;
  if (SWITCH_ON.has(raw)) return true;
  if (SWITCH_OFF.has(raw)) return false;
  // Assembled on every request: complain once per distinct bad value, not per turn.
  if (complained.get(file) !== raw) {
    complained.set(file, raw);
    dbg({ evt: 'miss', stage: 'tools-state', reason: `unrecognized "${raw}"`, file });
  }
  return fallback;
}

function describeSwitch(strip, file) {
  return strip
    ? `当前：**拦截工具** —— ChatOnly 请求里不带任何工具 schema。\n文件：${file}`
    : `当前：**放行工具** —— 工具由其他插件/预设决定，本包不干预。\n文件：${file}`;
}

/**
 * `/chattools [on | off | status | reset]` — the live switch for tool
 * interception. Writing the file is enough: the assembly listener re-reads it on
 * the next request.
 */
function registerToolsCommand(ctx, file, fallback) {
  ctx.effect(() => ctx.commands.register({
    name: 'chattools',
    description: '切换 ChatOnly 是否拦截工具（默认拦截；关闭后由其他插件管理工具）',
    input: { hint: 'on | off | status | reset' },
    handler: async (invocation) => {
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase();
      if (arg.length === 0 || arg === 'status') {
        return { kind: 'success', text: `${describeSwitch(readSwitch(file, fallback), file)}\n用法：/chattools on | off | reset` };
      }
      if (arg === 'reset') {
        try {
          fs.rmSync(file, { force: true });
          return { kind: 'success', text: `已恢复默认（${fallback ? '拦截' : '放行'}），下一条消息生效。` };
        } catch (error) {
          return { kind: 'error', text: `删除失败：${String(error)}` };
        }
      }
      let value;
      if (SWITCH_ON.has(arg)) value = true;
      else if (SWITCH_OFF.has(arg)) value = false;
      else return { kind: 'error', text: `不认识的参数「${arg}」。用法：/chattools on | off | status | reset` };

      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value ? 'strip' : 'pass', 'utf8');
      } catch (error) {
        return { kind: 'error', text: `写入失败：${String(error)}` };
      }
      dbg({ evt: 'tools-toggle', strip: value, file, via: 'command' });
      return {
        kind: 'success',
        text: value
          ? `已切换为**拦截**：下一条消息起 ChatOnly 不带工具。\n文件：${file}`
          : `已切换为**放行**：下一条消息起工具由其他插件/预设决定，本包不再清空。\n文件：${file}`,
      };
    },
  }), 'chat-preset.tools-command()');
}


/**
 * The preset a Session currently runs under, from the `agentPreset` Session
 * projection (`dsh-agent-preset-registry`): initialized from the creation
 * header, advanced by the last `agent-preset/selected` event. Falls back to
 * the header alone when the projection is unavailable.
 */
function readPresetId(ctx, agent) {
  const session = agent?.session;
  let state;
  try {
    // Declared via `inject`, but a resolution failure here must fall back to
    // the header rather than skip the whole filter (the first live run lost the
    // preset entirely to a "without inject" throw).
    state = typeof ctx?.sessionProjections?.stateOf === 'function' && session !== undefined
      ? ctx.sessionProjections.stateOf(session, 'agentPreset')
      : undefined;
  } catch (error) {
    dbg({ evt: 'error', stage: 'preset-projection', message: String(error), sessionId: session?.id ?? null });
    state = undefined;
  }
  if (typeof state === 'string' && state !== '') return state;
  const header = session?.header?.agentPreset;
  return typeof header === 'string' && header !== '' ? header : undefined;
}

/**
 * Install the empty, non-required shadow of `contextName` in the agent's own
 * scope. Never registers through the plugin's own context: that layer is
 * global and would strip the contribution for every preset.
 *
 * The registration runs inside a tiny plugin MOUNTED INTO the agent scope, so
 * (a) `systemPrompt` resolves there (its fiber declares the dependency — the
 * agent scope fiber does not, so a bare `agent.ctx.systemPrompt` lookup fails
 * with "without inject"), and (b) the registration is owned by that fiber, so
 * it disappears with the agent.
 */
function suppress(agent, contextName, installed) {
  if (installed.has(agent)) return;
  const scopeCtx = agent?.ctx;
  const sessionId = agent?.session?.id ?? null;
  const register = (c) => {
    c.systemPrompt.context({
      name: contextName,
      order: typeof c.systemPrompt.getContextOrder === 'function'
        ? (c.systemPrompt.getContextOrder('WORKING_DIRECTORY') ?? DEFAULT_CONTEXT_ORDER)
        : DEFAULT_CONTEXT_ORDER,
      required: false,
      interpolate: false,
      text: '',
    });
    dbg({ evt: 'suppress', contextName, sessionId, agentId: agent?.id ?? null, via: 'agent-scope-plugin' });
  };

  if (typeof scopeCtx?.plugin === 'function') {
    scopeCtx.plugin({
      name: 'chat-preset:context-shadow',
      inject: ['systemPrompt'],
      apply(c) {
        try {
          register(c);
        } catch (error) {
          dbg({ evt: 'error', stage: 'register', message: String(error), sessionId });
        }
      },
    });
    installed.add(agent);
    return;
  }

  // Fallback for a scope object that is not a Cordis context.
  const prompt = scopeCtx?.systemPrompt;
  if (typeof prompt?.context !== 'function') {
    dbg({ evt: 'miss', reason: 'agent.ctx has neither plugin() nor systemPrompt', sessionId });
    return;
  }
  try {
    register({ systemPrompt: prompt });
    installed.add(agent);
  } catch (error) {
    dbg({ evt: 'error', stage: 'register-fallback', message: String(error), sessionId });
  }
}

// --- /chatprompt -------------------------------------------------------------
// The composer-side editor for the system prompt above. Registered from the
// GLOBAL mount only: `commands.register()` scopes by the calling context, so a
// per-agent registration would collide as soon as a second ChatOnly agent exists.

/** `/chatprompt [text | show | clear]` */
function registerCommand(ctx, file) {
  const target = expandHome(file);
  ctx.effect(() => ctx.commands.register({
    name: 'chatprompt',
    description: '查看/设置 ChatOnly 的系统提示词（写入文件，下一条消息生效）',
    input: { hint: '文本 | show | clear' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '');
      const arg = raw.trim();
      if (arg.length === 0) {
        const text = readPrompt(target);
        return {
          kind: 'success',
          text: text.length === 0
            ? `当前系统提示词为空。\n文件：${target}\n用法：/chatprompt 你是一个……`
            : `当前系统提示词（${text.length} 字）：\n${preview(text)}\n\n文件：${target}`,
        };
      }
      if (arg === 'show') {
        const text = readPrompt(target);
        return { kind: 'success', text: text.length === 0 ? '(空)' : `${text}\n\n— 文件：${target}` };
      }
      if (arg === 'clear') {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, '', 'utf8');
          return { kind: 'success', text: `已清空，下一条消息起不再发送系统提示词。\n文件：${target}` };
        } catch (error) {
          return { kind: 'error', text: `写入失败：${String(error)}` };
        }
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const body = raw.trim();
        fs.writeFileSync(target, body, 'utf8');
        return { kind: 'success', text: `已保存（${body.length} 字），下一条消息生效。\n文件：${target}` };
      } catch (error) {
        return { kind: 'error', text: `写入失败：${String(error)}` };
      }
    },
  }), 'chat-preset.command()');
}

// --- role: 'section' -------------------------------------------------------------
// Mounted INSIDE the preset (see the `plugins` list in cordis.patch.yml), where it
// shadows the deployment persona by section name. `text` is a FUNCTION, so
// `SystemPrompt.assemble()` re-reads the file on every assembly
// (`dsh-system-prompt/lib/index.js:388`) — edit the file and the next message uses
// it, no restart.
//
// The persona row must NOT be mounted next to this one: two registrations of one
// section name inside one scope throw.

/** Cordis rejects two `complete` sections, so this role owns the slot alone. */
function applySection(ctx, config = {}) {
  const file = expandHome(config.file ?? DEFAULT_PROMPT_FILE);
  const prompt = ctx.systemPrompt;
  ctx.effect(() => prompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    complete: true,
    text: () => readPrompt(file),
  }), 'chat-preset.section()');
  ctx.effect(() => prompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '',
  }), 'chat-preset.suffix()');
  // What the persona row's `includeRuntimeContext: false` used to do.
  ctx.effect(() => prompt.suppressRuntimeContext(), 'chat-preset.suppress()');
  dbg({ evt: 'prompt-section', file, length: readPrompt(file).length, pid: process.pid });
}

/** The current prompt; a missing or unreadable file means "no system prompt". */
function readPrompt(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function preview(text) {
  return text.length <= 400 ? text : `${text.slice(0, 400)}\n…（共 ${text.length} 字，用 /chatprompt show 查看全文）`;
}

function expandHome(file) {
  if (file === '~') return os.homedir();
  if (file.startsWith('~/') || file.startsWith('\\')) return path.join(os.homedir(), file.slice(2));
  return file;
}

/**
 * `policy` (default, mounted globally): keeps the runtime context and the global
 * tool schemas out of ChatOnly requests, and owns the `/chatprompt` command.
 * `section`: the system-prompt slot, mounted inside the preset.
 */
export function apply(ctx, config = {}) {
  if ((config.role ?? 'policy') === 'section') applySection(ctx, config);
  else applyPolicy(ctx, config);
}
