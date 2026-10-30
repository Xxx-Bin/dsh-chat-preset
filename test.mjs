import { apply } from './index.js';

// keep test runs out of the app's debug log
process.env.DSH_FILTER_RTC_DEBUG = '0';

// ---------------------------------------------------------------------------
// Faithful-enough model of the installed build's @deepseek-ai/dsh-system-prompt
// + dsh-agent-loop step() semantics (see index.js header for the source lines).
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

// --- renderContextSections / joinContextSections / project / step -----------
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

// --- harness ---------------------------------------------------------------
function makeWorld({ presetId, headerPreset = presetId, suppressed = true, hasScopedPrompt = true }) {
  const prompt = makePrompt();
  const session = { id: 'sess-1', header: { agentPreset: headerPreset } };
  const agent = { id: 'agent-1', session };
  if (hasScopedPrompt) agent.ctx = { systemPrompt: prompt.forScope(agent) };
  if (suppressed) prompt.layerOf(agent).suppressors += 1;   // persona includeRuntimeContext:false

  const listeners = [];
  const ctx = {
    on(evt, cb) { if (evt === 'agent/pre-step') listeners.push(cb); },
    sessionProjections: { stateOf: (s, key) => (s === session && key === 'agentPreset' ? presetId : undefined) },
    commands: { register: () => () => {} },
    effect(fn) { return fn(); },
    logger: { warn: (...a) => console.log('   [warn]', ...a) },
  };
  apply(ctx, { presetId: 'chatonly' });

  const claimed = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];

  /** One full turn step: preStep (assembly -> waterfall -> decision) then step(). */
  const run = () => {
    const assembly = prompt.assemble(agent);
    const defaultDecision = () => {
      const sections = renderContextSections(assembly);
      const context = project(joinContextSections(sections), sections);
      return Promise.resolve({ kind: 'enter', messages: context === undefined ? [...claimed] : [...claimed, context] });
    };
    let chain = defaultDecision;
    for (let i = listeners.length - 1; i >= 0; i--) {
      const cb = listeners[i];
      const prev = chain;
      chain = () => cb({ agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal }, prev);
    }
    return chain().then((decision) => {
      // step(): the request path recomputes the context, ignoring decision.messages.
      const sections = renderContextSections(prompt.refreshContext(agent, assembly));
      const context = project(joinContextSections(sections), sections);
      const surface = [...claimed, ...(context === undefined ? [] : [context])];
      return { decision, surface, assembly };
    });
  };
  return { prompt, agent, run };
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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
