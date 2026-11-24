import { apply } from './index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// keep test runs out of the app's debug log
process.env.DSH_FILTER_RTC_DEBUG = '0';

// ---------------------------------------------------------------------------
// Faithful-enough model of the installed build:
//   - @deepseek-ai/dsh-system-prompt  assemble() / refreshContext()
//   - @deepseek-ai/dsh-tools          view(scope) + restrict()  (see index.js)
//   - dsh-agent-loop                  claim() -> resolve() -> assemble() -> pre-step
// ---------------------------------------------------------------------------

const WORKING_DIRECTORY = 'working-directory:current';

/** ScopedLayers (dsh-scope): global names + per-scope shadows, nearest scope wins. */
function makePrompt() {
  const global = { contexts: new Map(), suppressors: 0 };
  const scoped = new Map();
  const layerOf = (scope) => {
    if (scope === undefined) return global;
    let layer = scoped.get(scope);
    if (layer === undefined) { layer = { contexts: new Map(), suppressors: 0 }; scoped.set(scope, layer); }
    return layer;
  };
  const merged = (scope) => {
    const m = new Map(global.contexts);
    for (const [name, reg] of layerOf(scope).contexts) m.set(name, reg);
    return m;
  };
  const isSuppressed = (scope) => global.suppressors > 0 || layerOf(scope).suppressors > 0;
  const resolve = (reg) => ({ name: reg.name, text: typeof reg.text === 'function' ? reg.text() : reg.text, interpolate: reg.interpolate });

  // The working-directory plugin's own registration + its `{ prepend: true }`
  // assemble listener that re-injects the real text after everyone else.
  global.contexts.set(WORKING_DIRECTORY, {
    name: WORKING_DIRECTORY,
    order: 100,
    required: true,
    interpolate: false,
    text: () => 'Current working directory: "C:\\\\Users\\\\dev\\\\project".',
  });

  function assemble(scope) {
    const suppressed = isSuppressed(scope);
    const providers = merged(scope);
    const assembly = {
      contexts: [...providers.values()]
        .filter((entry) => !suppressed || entry.required === true)
        .sort((a, b) => a.order - b.order)
        .map(resolve),
    };
    // working-directory's post-next() enforcement
    const text = 'Current working directory: "C:\\\\Users\\\\dev\\\\project".';
    const contribution = assembly.contexts.find((entry) => entry.name === WORKING_DIRECTORY);
    if (contribution === undefined) assembly.contexts.unshift({ name: WORKING_DIRECTORY, text, interpolate: false });
    else { contribution.text = text; contribution.interpolate = false; }
    if (!suppressed) return assembly;
    const requiredNames = new Set([...providers.values()].filter((e) => e.required === true).map((e) => e.name));
    return { ...assembly, contexts: assembly.contexts.filter((e) => requiredNames.has(e.name)) };
  }

  function refreshContext(scope, assembly) {
    const suppressed = isSuppressed(scope);
    const providers = merged(scope);
    const required = new Map([...providers].filter(([, entry]) => entry.required === true));
    const contexts = [];
    for (const accepted of assembly.contexts) {
      const provider = providers.get(accepted.name);
      required.delete(accepted.name);
      if (suppressed && provider?.required !== true) continue;
      contexts.push(provider === undefined ? accepted : { ...resolve(provider) });
    }
    for (const provider of required.values()) contexts.push(resolve(provider));
    return { ...assembly, contexts };
  }

  return {
    globalLayer: global,
    layerOf,
    isSuppressed,
    assemble,
    refreshContext,
    /** The per-agent scoped facade: `agent.ctx.systemPrompt`. */
    forScope: (scope) => ({
      context(reg) {
        if (layerOf(scope).contexts.has(reg.name)) throw new Error(`prompt context "${reg.name}" is already registered in this scope`);
        layerOf(scope).contexts.set(reg.name, reg);
      },
      getContextOrder: (key) => (key === 'WORKING_DIRECTORY' ? 100 : undefined),
    }),
  };
}

// --- renderContextSections / joinContextSections / project ---------------
const renderContextSections = (assembly) => assembly.contexts
  .map((c) => ({ name: c.name, text: c.interpolate === false ? c.text : c.text }))
  .filter((s) => s.text.length > 0);
const joinContextSections = (sections) => {
  const body = sections.map((s) => s.text).join('\n\n');
  return body.length === 0 ? '' : `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
};
/** RuntimeContextProjection.project with no retained snapshot (fresh session). */
const project = (current, sections) => (current.length === 0 ? undefined : {
  id: 'snapshot',
  role: 'user',
  content: [{ type: 'text', text: current }],
  source: sections.length === 0 ? { kind: 'runtime-context' } : { kind: 'runtime-context', form: 'snapshot', sections },
});

// --- dsh-tools model: view(scope) + restrict() ------------------------------
// Global tools stand for what the desktop bundles register (acp_*, …); preset
// tools stand for rows in the preset's own `plugins` list (the tool-web row).
function makeTools({ globalNames = [], presetNames = [] } = {}) {
  const presetScope = { kind: 'preset' };
  const globalLayer = { tools: new Map(globalNames.map((n) => [n, { name: n }])), restrictions: [] };
  const layers = new Map();
  const layerOf = (scope) => {
    if (scope === undefined) return globalLayer;
    let layer = layers.get(scope);
    if (layer === undefined) { layer = { tools: new Map(), restrictions: [] }; layers.set(scope, layer); }
    return layer;
  };
  for (const name of presetNames) layerOf(presetScope).tools.set(name, { name });

  /** Nearest-first chain: agent -> preset (root/global is separate). */
  const chainOf = (scope) => {
    const chain = [];
    for (let s = scope; s !== undefined; s = s.parent) chain.push(layerOf(s));
    return chain;
  };
  /** dsh-tools:392 — a restriction denies a name unless every filter admits it. */
  const admits = (layer, name) => layer.restrictions.every((f) => !(
    (f.allow !== undefined && !f.allow.has(name)) || (f.deny !== undefined && f.deny.has(name))
  ));

  /** dsh-tools:477 — inherited tools pass every layer's admits(); own tools skip it. */
  const view = (scope) => {
    const chain = chainOf(scope);
    const own = chain[0];
    const inherited = new Map(globalLayer.tools);
    for (const layer of [...chain].reverse()) {
      if (layer === own) continue;
      for (const [name, reg] of layer.tools) inherited.set(name, reg);
    }
    const visible = new Map();
    for (const [name, reg] of inherited) if (chain.every((layer) => admits(layer, name))) visible.set(name, reg);
    for (const [name, reg] of own.tools) visible.set(name, reg);
    return visible;
  };

  /** dsh-tools:453 — records one restriction in the CALLING scope's layer. */
  const restrictIn = (scope, filter) => {
    if (scope === undefined) throw new Error('tools.restrict() requires a scoped context (agent.ctx)');
    if (filter.allow === undefined && filter.deny === undefined) throw new Error('tools.restrict({}) is a no-op');
    const compiled = {};
    if (filter.allow !== undefined) compiled.allow = new Set(filter.allow);
    if (filter.deny !== undefined) compiled.deny = new Set(filter.deny);
    const list = layerOf(scope).restrictions;
    list.push(compiled);
    let lifted = false;
    return () => {
      if (lifted) return;
      lifted = true;
      const index = list.indexOf(compiled);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const restrictionCount = (scope) => layerOf(scope).restrictions.length;
  const names = (scope) => [...view(scope).keys()];
  return { presetScope, layerOf, view, restrictIn, restrictionCount, names };
}

// --- harness ---------------------------------------------------------------
const BASE_TOOLS = ['acp_status', 'working_directory', 'search_context'];
/** The `tool-web` row now declared in cordis.patch.yml under the preset. */
const PRESET_TOOLS = ['web_search', 'web_fetch'];

/** A state file inside a throwaway dir — never the user's real ~/.dsh one. */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-preset-'));
let tmpSeq = 0;
const tmpState = () => path.join(TMP_DIR, `state-${++tmpSeq}.txt`);

function makeWorld({
  presetId,
  headerPreset = presetId,
  suppressed = true,
  hasScopedPrompt = true,
  stripTools,
  toolsStateFile = tmpState(),
  presetToolNames = presetId === 'chatonly' ? PRESET_TOOLS : [],
  agentToolNames = [],
} = {}) {
  const prompt = makePrompt();
  const session = { id: 'sess-1', header: { agentPreset: headerPreset } };
  const agent = { id: 'agent-1', session };
  const registry = makeTools({ globalNames: BASE_TOOLS, presetNames: presetToolNames });
  agent.parent = registry.presetScope;
  for (const name of agentToolNames) registry.layerOf(agent).tools.set(name, { name });

  if (suppressed) prompt.layerOf(agent).suppressors += 1;   // persona includeRuntimeContext:false

  const claimedListeners = [];
  const listeners = [];
  const commands = [];
  const mounts = { plugin: 0, apply: 0 };

  const scopePrompt = prompt.forScope(agent);
  // What `inject: ['tools']` resolves in the agent scope: a facade bound to it.
  const scopeFacade = {
    systemPrompt: scopePrompt,
    tools: {
      restrict: (filter) => registry.restrictIn(agent, filter),
      get: (name) => registry.view(agent).get(name),
    },
  };

  if (hasScopedPrompt) {
    agent.ctx = {
      systemPrompt: scopePrompt,
      /** cordis `ctx.plugin()`: applies at once when the declared inject resolves. */
      plugin(def) {
        mounts.plugin++;
        const missing = (def.inject ?? []).filter((key) => scopeFacade[key] === undefined);
        if (missing.length === 0) { mounts.apply++; def.apply(scopeFacade); }
      },
    };
  }

  let currentPreset = presetId;
  const ctx = {
    on(evt, cb) {
      if (evt === 'agent/pre-step') listeners.push(cb);
      else if (evt === 'agent/inbox/claimed') claimedListeners.push(cb);
    },
    sessionProjections: { stateOf: (s, key) => (s === session && key === 'agentPreset' ? currentPreset : undefined) },
    commands: { register: (cmd) => { commands.push(cmd); return () => {}; } },
    effect(fn) { return fn(); },
    logger: { warn: (...a) => console.log('   [warn]', ...a) },
  };
  apply(ctx, { presetId: 'chatonly', stripTools, toolsStateFile });

  const claimed = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];

  /** dsh-agent-loop:683 — claim emits synchronously, BEFORE resolve/assemble. */
  const claim = (messages) => {
    for (const message of messages) for (const cb of claimedListeners) cb({ agent, message, turn: 1 });
  };

  /** What buildRequest would carry: `tools` is omitted when the list is empty. */
  const requestTools = () => {
    const list = [...registry.view(agent).values()];
    return list.length === 0 ? undefined : list;
  };

  /** preStep (:683 claim -> :686 resolve -> :692 assemble -> :698 waterfall). */
  const run = (messages = claimed) => {
    claim(messages);
    const assembly = { ...prompt.assemble(agent), tools: [...registry.view(agent).values()] };
    const defaultDecision = () => {
      const sections = renderContextSections(assembly);
      const context = project(joinContextSections(sections), sections);
      return Promise.resolve({ kind: 'enter', messages: context === undefined ? [...messages] : [...messages, context] });
    };
    let chain = defaultDecision;
    for (let i = listeners.length - 1; i >= 0; i--) {
      const cb = listeners[i];
      const prev = chain;
      chain = () => cb({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, prev);
    }
    return chain().then((decision) => {
      // step(): the request path recomputes the context, ignoring decision.messages.
      const sections = renderContextSections(prompt.refreshContext(agent, assembly));
      const context = project(joinContextSections(sections), sections);
      const surface = [...messages, ...(context === undefined ? [] : [context])];
      return { decision, surface, assembly };
    });
  };

  /** One more message's worth of assembly, without running the context part. */
  const stepTools = () => { claim(claimed); return requestTools(); };

  /** The pre-step waterfall alone (no new message claimed) — the fallback path. */
  const preStep = () => {
    let chain = () => Promise.resolve({ kind: 'enter', messages: [] });
    for (let i = listeners.length - 1; i >= 0; i--) {
      const cb = listeners[i];
      const prev = chain;
      chain = () => cb({ agent, messages: [], turn: 1, step: 1 }, prev);
    }
    return chain();
  };

  const command = (name) => commands.find((c) => c.name === name);
  const switchPreset = (id) => { currentPreset = id; };
  return { prompt, agent, registry, mounts, run, tools: stepTools, requestTools, preStep, switchPreset, commands, command, toolsStateFile, presetScope: registry.presetScope };
}

let failures = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === undefined ? '' : `  -> ${extra}`}`);
  if (!cond) failures++;
}
const runtimeContextOn = (surface) => surface.filter((m) => m.source?.kind === 'runtime-context');

// a) chatonly: snapshot neither on the surface nor in the request
{
  const w = makeWorld({ presetId: 'chatonly' });
  const { decision, surface } = await w.run();
  check('a: chatonly -> runtime context never committed to the surface', runtimeContextOn(surface).length === 0, JSON.stringify(surface.map((m) => m.id)));
  check('a2: decision stays an enter with the claimed messages', decision.kind === 'enter' && decision.messages.length >= 1);
  check('a3: shadow registered in the AGENT scope, not the global layer', w.prompt.layerOf(w.agent).contexts.has(WORKING_DIRECTORY) && w.prompt.globalLayer.contexts.get(WORKING_DIRECTORY).required === true);
  check('a4: shadow is non-required and renders to nothing', (() => {
    const reg = w.prompt.layerOf(w.agent).contexts.get(WORKING_DIRECTORY);
    return reg.required === false && reg.text === '' && reg.interpolate === false;
  })());
}

// b) other preset: untouched
{
  const w = makeWorld({ presetId: 'standard', suppressed: false });
  const { surface } = await w.run();
  check('b: other preset keeps the snapshot', runtimeContextOn(surface).length === 1);
  check('b2: other preset got no shadow', !w.prompt.layerOf(w.agent).contexts.has(WORKING_DIRECTORY));
}

// c) repeated steps: one registration, no duplicate-name throw
{
  const w = makeWorld({ presetId: 'chatonly' });
  const first = await w.run();
  const second = await w.run();
  check('c: second step does not re-register (no throw), still clean', runtimeContextOn(first.surface).length === 0 && runtimeContextOn(second.surface).length === 0);
  check('c2: exactly one scoped entry', w.prompt.layerOf(w.agent).contexts.size === 1);
}

// d) the Session projection is authoritative over the creation header
{
  const w = makeWorld({ presetId: 'standard', headerPreset: 'chatonly', suppressed: false });
  const { surface } = await w.run();
  check('d: projection (standard) wins over header (chatonly)', runtimeContextOn(surface).length === 1);
}

// e) no scoped prompt capability: graceful pass-through
{
  const w = makeWorld({ presetId: 'chatonly', hasScopedPrompt: false });
  const { surface } = await w.run();
  check('e: missing agent.ctx.systemPrompt -> untouched, no crash', runtimeContextOn(surface).length === 1);
}

// f) decision object handed back verbatim
{
  const w = makeWorld({ presetId: 'chatonly' });
  const { agent } = w;
  const listeners = [];
  const prompt = makePrompt();
  prompt.layerOf(agent).suppressors += 1;
  const ctx = {
    on(evt, cb) { if (evt === 'agent/pre-step') listeners.push(cb); },
    sessionProjections: { stateOf: () => 'chatonly' },
    commands: { register: () => () => {} },
    effect(fn) { return fn(); },
  };
  agent.ctx = { systemPrompt: prompt.forScope(agent) };
  apply(ctx, {});
  const original = { kind: 'enter', messages: ['x'], startsRequestSeries: true };
  const out = await listeners[0]({ agent }, () => Promise.resolve(original));
  check('f: plugin returns the downstream decision unchanged', out === original);
}

// g) tools: factory default is interception, through the registry view
{
  const w = makeWorld({ presetId: 'chatonly' });
  const list = w.tools();
  check('g: chatonly, no state file -> tools omitted from the request', list === undefined, JSON.stringify(list));
  check('g2: no state file is created just by reading the switch', !fs.existsSync(w.toolsStateFile), w.toolsStateFile);
  check('g3: the restriction sits on the AGENT layer, not the preset layer',
    w.registry.restrictionCount(w.agent) === 1 && w.registry.restrictionCount(w.presetScope) === 0);
}

// h) tools: the switch off hands every tool back
{
  const file = tmpState();
  fs.writeFileSync(file, 'pass\n', 'utf8');
  const w = makeWorld({ presetId: 'chatonly', toolsStateFile: file });
  const list = w.tools();
  check('h: switch off -> global + preset tools all survive', Array.isArray(list) && list.length === BASE_TOOLS.length + PRESET_TOOLS.length, JSON.stringify(list?.map((t) => t.name)));
  check('h2: the preset tool-web row is visible when passing', list?.some((t) => t.name === 'web_search') === true);

  const w2 = makeWorld({ presetId: 'standard', toolsStateFile: file });
  const list2 = w2.tools();
  check('h3: other preset untouched, and it carries no web row', Array.isArray(list2) && list2.length === BASE_TOOLS.length);
}

// i) tools: `/filtertools` flips the switch live, no restart
{
  const w = makeWorld({ presetId: 'chatonly' });
  const cmd = w.command('filtertools');
  check('i: /filtertools is registered', typeof cmd?.handler === 'function');
  const call = (raw) => cmd.handler({ rawInput: raw });

  check('i2: default state reads as intercept', (await call('')).text.includes('拦截工具'));
  const off = await call('off');
  check('i3: `/filtertools off` succeeds', off.kind === 'success' && off.text.includes('放行'), off.text);
  check('i4: the very next message carries every tool again', w.tools()?.length === BASE_TOOLS.length + PRESET_TOOLS.length);

  const on = await call('on');
  check('i5: `/filtertools on` masks them again on the next message', on.kind === 'success' && w.tools() === undefined, on.text);

  const bogus = await call('maybe');
  check('i6: unknown argument is rejected, switch untouched', bogus.kind === 'error' && w.tools() === undefined, bogus.text);

  const reset = await call('reset');
  check('i7: `reset` deletes the file and falls back to the default', reset.kind === 'success' && w.tools() === undefined);
}

// j) tools: `stripTools: false` is the factory default, not a hard opt-out
{
  const w = makeWorld({ presetId: 'chatonly', stripTools: false });
  check('j: stripTools:false -> nothing masked before any toggle', w.tools()?.length === BASE_TOOLS.length + PRESET_TOOLS.length);
  await w.command('filtertools').handler({ rawInput: 'on' });
  check('j2: /filtertools on still works over that default', w.tools() === undefined);
}

// k) the restriction masks inherited tools only — a scope-owned one survives
{
  const w = makeWorld({ presetId: 'chatonly', agentToolNames: ['local_tool'] });
  const list = w.tools();
  check('k: a tool registered in the agent scope is exempt from restrict()',
    list?.length === 1 && list[0].name === 'local_tool', JSON.stringify(list?.map((t) => t.name)));
}

// l) on/off cycles reuse ONE scope plugin and never stack restrictions
{
  const w = makeWorld({ presetId: 'chatonly' });
  const call = (raw) => w.command('filtertools').handler({ rawInput: raw });
  w.tools();
  await call('off'); w.tools();
  await call('on'); w.tools();
  await call('off'); w.tools();
  await call('on'); w.tools();
  check('l: the scope plugin is mounted exactly once', w.mounts.plugin === 1, JSON.stringify(w.mounts));
  check('l2: exactly one restriction is live', w.registry.restrictionCount(w.agent) === 1);
}

// m) a resumed step with no claimed message still reconciles (one step late)
{
  const file = tmpState();
  fs.writeFileSync(file, 'pass\n', 'utf8');
  const w = makeWorld({ presetId: 'chatonly', toolsStateFile: file });
  w.tools();                                        // off: nothing armed
  fs.writeFileSync(file, 'strip\n', 'utf8');        // flip while the agent is idle
  await w.preStep();                                // fallback path, no new message
  check('m: the pre-step fallback still arms the restriction', w.registry.restrictionCount(w.agent) === 1);
}

// n) no agent.ctx.plugin: degrade to "no restriction", never crash
{
  const w = makeWorld({ presetId: 'chatonly', hasScopedPrompt: false });
  const list = w.tools();
  check('n: missing agent.ctx.plugin degrades to a full tool list', list?.length === BASE_TOOLS.length + PRESET_TOOLS.length, JSON.stringify(list?.map((t) => t.name)));
}

// p) switching the session to another preset lifts the mask
{
  const w = makeWorld({ presetId: 'chatonly' });
  w.tools();
  const before = w.registry.restrictionCount(w.agent);
  w.switchPreset('standard');
  const list = w.tools();
  check('p: preset switch removes the restriction on the next message',
    before === 1 && w.registry.restrictionCount(w.agent) === 0, JSON.stringify({ before, after: w.registry.restrictionCount(w.agent) }));
  check('p2: and the tools come back', list?.length === BASE_TOOLS.length + PRESET_TOOLS.length);
}

// o) other presets never mount the plugin
{
  const w = makeWorld({ presetId: 'standard', suppressed: false });
  w.tools();
  check('o: other preset never mounts the restriction plugin', w.mounts.plugin === 0, JSON.stringify(w.mounts));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
fs.rmSync(TMP_DIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
