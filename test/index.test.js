import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, internals, name, inject, Config, CONTEXT_NAME, VARIABLE_NAME } from '../lib/index.js'

const { resolveOptions, readOccupancy, settleBand, quantize, quantizeHeadroom, headroomDisplayStep, render, patchCompactionInstruction, patchCompactionRequest, isCompactionRequest, isTaggedCompactionRequest, messageText, DEFAULT_OPTIONS, DEFAULT_COMPACTION_RULES, PACE_LADDER, median, nextPaceState, samplePace, paceSteps, paceRung, settlePace, paceSentence, tightClause, foldClause, shouldFoldAtIdle, backendIdentity } = internals

const { resolveFoldMode, handoffTrigger, handoffRoot, handoffPathFor, handoffPrepMessage, handoffActivationMessage, handoffReapable, sweepHandoffs, handoffFileChars, safeSegment, sessionIdOf, isDelegate, samePath, HANDOFF_TOOL_NAME, HANDOFF_MIN_CHARS, HANDOFF_MAX_AGE_MS, HANDOFF_STATE_FILE } = internals

/** A 1M window reserving the DeepSeek adapter's default 256K completion tokens. */
const WINDOW = 1000000
const MAX_TOKENS = 256000
/** min(0.8 * 1M, 1M - 256K - 64K) — the compaction point this deployment runs at. */
const THRESHOLD = 678464

/** Minimal ctx capturing what the plugin registers. */
function stubContext({ used, meter, projections, compaction, commands, logs, tools } = {}) {
  const registered = { variable: undefined, context: undefined, listeners: {}, injections: [], tools: [], effects: [], disposers: [], timers: [] }
  const tokenMeter = meter === undefined ? { measure: () => ({ totalTokens: used }) } : meter
  // A host always mounts the tools service, so the stub does too: without it the
  // handoff tool cannot register and every log assertion would see that warning.
  // `register` returns the disposer a real host returns, so a test can observe the
  // tool following a live fold-mode switch.
  const toolsService =
    tools === undefined
      ? {
          register: (definition) => {
            registered.tools.push(definition)
            let live = true
            return () => {
              if (!live) return
              live = false
              const index = registered.tools.indexOf(definition)
              if (index >= 0) registered.tools.splice(index, 1)
            }
          },
        }
      : tools
  const services = { tokenMeter, compaction, sessionProjections: projections, commands, tools: toolsService }
  const ctx = {
    logger:
      logs === undefined
        ? undefined
        : {
            info: (...args) => logs.push(['info', ...args]),
            warn: (...args) => logs.push(['warn', ...args]),
          },
    get: (key) => services[key],
    // Mirrors cordis: the callback runs with a child context exposing exactly the
    // requested services, and does not run at all when one of them is absent. The
    // child's properties are live, so a test that replaces `ctx.get` is followed —
    // which is also what the plugin relies on (it resolves per use, never once).
    inject: (names, callback) => {
      registered.injections.push(names)
      const child = { logger: ctx.logger, get: ctx.get, on: ctx.on, systemPrompt: ctx.systemPrompt }
      let ready = true
      for (const name of names) {
        if (ctx.get(name) === undefined) {
          ready = false
          continue
        }
        Object.defineProperty(child, name, { configurable: true, get: () => ctx.get(name) })
      }
      if (ready) callback(child)
    },
    systemPrompt: {
      variable: (variableName, provider) => {
        registered.variable = { name: variableName, provider }
      },
      context: (contribution) => {
        registered.context = contribution
      },
    },
    // Two capabilities now share `agent/status` (the idle fold and the handoff
    // fold), and a host runs every listener. Composing here keeps every existing
    // assertion working — `listeners[event](payload)` still fires all of them.
    on: (event, listener) => {
      const previous = registered.listeners[event]
      registered.listeners[event] =
        previous === undefined
          ? listener
          : (...args) => {
              previous(...args)
              listener(...args)
            }
    },
    effect: (callback, label) => {
      registered.effects.push(label)
      const dispose = callback()
      const disposer = typeof dispose === 'function' ? dispose : () => {}
      registered.disposers.push(disposer)
      return disposer
    },
    setInterval: (callback, ms) => {
      registered.timers.push({ callback, ms })
      return () => {}
    },
  }
  return { ctx, registered }
}

/** Minimal session exposing exactly the two readers the plugin uses. */
function stubSession({ window: contextWindow = WINDOW, maxTokens = MAX_TOKENS } = {}) {
  return {
    requestContext: () => ({ contextWindow }),
    requestHeader: () => ({ config: { maxTokens } }),
  }
}

/** The dynamic line for one session, through the registered provider. */
function lineFor(registered, session) {
  return registered.variable.provider({ agent: { session } })
}

const INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE.',
  '',
  'Rules:',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n')

/** A request shaped like the one dsh-compaction-basic dispatches. */
function compactionRequest() {
  return {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    purpose: 'compaction',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'earlier turn' }] },
      { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] },
    ],
  }
}

test('exports the cordis plugin shape', () => {
  assert.equal(name, 'context-truth')
  // A sibling entry's service is reachable only through cordis injection, and both
  // services are declared here: `ctx.get` and `ctx.inject(name, cb)` each came back
  // empty in a live deployment, while `/compact` (declaring its injections) works.
  assert.deepEqual(inject, ['systemPrompt', 'tokenMeter'])
  assert.equal(typeof apply, 'function')
})

test('registers one variable, one ordered context, and the stream interceptor', () => {
  const { ctx, registered } = stubContext({ used: 100000 })
  apply(ctx, {})
  assert.equal(registered.variable.name, VARIABLE_NAME)
  assert.equal(registered.context.name, CONTEXT_NAME)
  assert.equal(registered.context.text, `{{${VARIABLE_NAME}}}`)
  assert.equal(registered.context.order, 100)
  assert.equal(typeof registered.listeners['llm/stream'], 'function')
})

test('derives the compaction point the way dsh-compaction-basic does', () => {
  const { ctx } = stubContext({ used: 170000 })
  const reading = readOccupancy(ctx, stubSession(), resolveOptions({}))
  assert.equal(reading.used, 170000)
  assert.equal(reading.window, WINDOW)
  assert.equal(reading.reserved, MAX_TOKENS)
  assert.equal(reading.threshold, THRESHOLD)
})

test('a healthy session renders numbers, the compaction point, and the calm band', () => {
  const { ctx, registered } = stubContext({ used: 172437 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /Context occupancy \(host-measured\): 150K \/ 1\.00M tokens used \(15%\)/)
  assert.match(line, /Automatic compaction fires at 678K \(68% of the window\)/)
  assert.match(line, /About 500K tokens of headroom remain/)
  assert.match(line, /Context is NOT scarce/)
  assert.match(line, /only authority on context pressure/)
  assert.match(line, /are stale/)
})

test('rising pressure moves the band; falling pressure needs the hysteresis margin', () => {
  const options = resolveOptions({})
  assert.equal(settleBand(0.2, undefined, options), 'ample')
  assert.equal(settleBand(0.6, 'ample', options), 'moderate')
  assert.equal(settleBand(0.9, 'moderate', options), 'tight')
  assert.equal(settleBand(1.05, 'tight', options), 'critical')
  // Just under the compaction point stays critical: the drop is smaller than the margin.
  assert.equal(settleBand(0.99, 'critical', options), 'critical')
  // A compaction that actually lands falls clear of the floor and re-arms the calm band.
  assert.equal(settleBand(0.1, 'critical', options), 'ample')
  assert.equal(settleBand(0.52, 'moderate', options), 'moderate')
  assert.equal(settleBand(0.4, 'moderate', options), 'ample')
})

test('quantization makes nearby readings byte-identical and steps coarsely', () => {
  const options = resolveOptions({})
  // 5% of a 1M window: the display bucket is [150000, 200000).
  assert.equal(quantize(172437, WINDOW, options), 150000)
  assert.equal(quantize(199999, WINDOW, options), 150000)
  assert.equal(quantize(200001, WINDOW, options), 200000)

  const { ctx, registered } = stubContext({ used: 172437 })
  apply(ctx, {})
  const session = stubSession()
  const first = lineFor(registered, session)
  ctx.get = (key) => (key === 'tokenMeter' ? { measure: () => ({ totalTokens: 172500 }) } : undefined)
  const second = lineFor(registered, session)
  assert.equal(first, second, 'a reading inside the same display step must not change the rendered snapshot')
  ctx.get = (key) => (key === 'tokenMeter' ? { measure: () => ({ totalTokens: 223000 }) } : undefined)
  assert.notEqual(lineFor(registered, session), second, 'crossing a display step must change it')
})

test('the displayed headroom never promises more room than the session has', () => {
  const options = resolveOptions({})
  for (const used of [172437, 400000, 600000, 610000, 650000, 670000, 678463]) {
    const headroom = THRESHOLD - used
    const shown = quantizeHeadroom(headroom, WINDOW, options)
    assert.ok(shown <= headroom, `shown ${shown} must not exceed the real ${headroom}`)
    assert.ok(headroom - shown < 50000, `shown ${shown} must stay useful against ${headroom}`)
  }
  // Near the compaction point the step tightens, so the number stays actionable.
  for (const headroom of [120000, 65000, 28464, 8464]) {
    const shown = quantizeHeadroom(headroom, WINDOW, options)
    assert.ok(headroom - shown < 12000, `shown ${shown} must be tight against ${headroom}`)
  }
  // The step coarsens as the room grows, which is what keeps re-injection rare.
  assert.equal(quantizeHeadroom(THRESHOLD - 172437, WINDOW, options), 500000)
  assert.equal(quantizeHeadroom(THRESHOLD - 610000, WINDOW, options), 60000)
  // And it stays coarse near the point: the floor is 10% of the window quantum,
  // because within a few tens of thousands of tokens the pace estimate is the
  // useful signal, and a 2K step re-injected the line on nearly every step.
  for (const headroom of [68464, 28464, 18464, 8464]) {
    assert.equal(headroomDisplayStep(headroom, WINDOW, options), 10000)
  }
})

test('the tight band names the small headroom and asks for nothing', () => {
  const { ctx, registered } = stubContext({ used: 610000 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /About 60K tokens of headroom remain/)
  assert.doesNotMatch(line, /Context is NOT scarce/)
  // The default tight line carries no advice: no fold notice, no hand-off order.
  assert.doesNotMatch(line, /folded into an LLM-written summary/)
  assert.doesNotMatch(line, /hand off/)
  assert.doesNotMatch(line, /finish the current step/)
  // ...and it says plainly that this is telemetry the model must not act on.
  assert.match(line, /Background telemetry from the host/)
  assert.match(line, /take no action about compaction/)
  // The measured figure is not an allowance: a live model counted it down on its
  // own (30K -> 28K -> 16K -> 10K -> 7K -> 5K) while the host kept reporting 10K.
  assert.match(line, /do not estimate or count it down yourself/)
})

test('over the compaction point the line stops promising headroom', () => {
  const { ctx, registered } = stubContext({ used: 700000 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /At or past the automatic compaction point/)
  // "About 0 tokens of headroom remain" is noise; the point itself says it.
  assert.doesNotMatch(line, /0 tokens of headroom/)
  assert.doesNotMatch(line, /more step/)
})

test('a broken meter degrades to the fallback text instead of throwing', () => {
  const { ctx, registered } = stubContext({
    meter: {
      measure: () => {
        throw new Error('meter replay is corrupt')
      },
    },
  })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /no reading yet in this session/)
  assert.match(line, /Do not claim context is scarce/)
})

test('the provider-reported projection is the fallback when the meter is absent', () => {
  const { ctx } = stubContext({
    meter: undefined,
    projections: {
      stateOf: () => ({ contextWindow: WINDOW, pressureTokens: 100000, surfaceTokens: 70000, sampledSurfaceTokens: 50000 }),
    },
  })
  const reading = readOccupancy(ctx, stubSession(), resolveOptions({}))
  assert.equal(reading.used, 120000)
  assert.equal(reading.window, WINDOW)
})

test('a missing window still renders a usable line', () => {
  const { ctx, registered } = stubContext({ used: 5000 })
  apply(ctx, {})
  const line = lineFor(registered, { requestContext: () => ({}), requestHeader: () => undefined })
  assert.match(line, /no reading yet in this session/)
})

test('language and switches are honoured', () => {
  const options = resolveOptions({ language: 'zh', staleClaimClause: false, authoritative: false })
  const rendered = render('ample', { quantized: 150000, window: WINDOW, threshold: THRESHOLD, percent: 15 }, options)
  assert.match(rendered, /上下文实况（宿主实测）/)
  assert.doesNotMatch(rendered, /唯一权威/)
  assert.doesNotMatch(rendered, /作废/)
})

test('disabled mounts no line, and leaves the other capabilities alone', () => {
  const { ctx, registered } = stubContext({ used: 1000 })
  apply(ctx, { enabled: false, patchCompactionPrompt: false })
  assert.equal(registered.variable, undefined)
  assert.equal(registered.context, undefined)
  // The listeners are installed unconditionally so a settings toggle can switch
  // them on without a reload; a disabled one no-ops per event instead.
  assert.equal(typeof registered.listeners['llm/stream'], 'function')
  assert.equal(typeof registered.listeners['agent/status'], 'function')
})

test('a second mount in the same scope stays inert instead of failing', () => {
  let variableCalls = 0
  let listenerCalls = 0
  const ctx = {
    logger: undefined,
    get: () => undefined,
    systemPrompt: {
      variable: () => {
        variableCalls += 1
        throw new Error('prompt variable "context_occupancy" is already registered')
      },
      context: () => {
        throw new Error('unreachable')
      },
    },
    on: () => {
      listenerCalls += 1
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(variableCalls, 1, 'the duplicate mount tries exactly once')
  assert.equal(listenerCalls, 0, 'the inert instance installs no interceptor')
})

test('an unrelated registration failure still surfaces', () => {
  const ctx = {
    logger: undefined,
    get: () => undefined,
    systemPrompt: {
      variable: () => {
        throw new Error('prompt variable name is invalid')
      },
      context: () => {},
    },
    on: () => {},
  }
  assert.throws(() => apply(ctx, {}), /name is invalid/)
})

test('the compaction directive gains the rules and keeps its own text intact', () => {
  const rules = resolveOptions({}).compactionRules
  const patched = patchCompactionInstruction(INSTRUCTION, rules)
  assert.ok(patched.startsWith(INSTRUCTION), 'the original directive must be preserved verbatim')
  assert.ok(patched.includes(rules[0]))
  assert.ok(patched.includes(rules[1]))
  assert.equal(patchCompactionInstruction(patched, rules), undefined, 'patching twice must be a no-op')
  assert.equal(patchCompactionInstruction('an ordinary user message', rules), undefined)
  assert.equal(patchCompactionInstruction(INSTRUCTION, []), undefined)
})

test('only the compaction request is recognised, and only its tail changes', () => {
  const rules = resolveOptions({}).compactionRules
  const request = compactionRequest()
  const prefixBefore = JSON.stringify(request.messages.slice(0, -1))

  assert.equal(isCompactionRequest(request), true)
  assert.equal(patchCompactionRequest(request, rules), true)
  assert.equal(JSON.stringify(request.messages.slice(0, -1)), prefixBefore, 'the cached prefix must stay byte-identical')
  assert.ok(messageText(request.messages.at(-1)).includes(rules[0]))
  assert.equal(patchCompactionRequest(request, rules), true, 'a second pass reports success without re-patching')
  assert.equal(request.messages.at(-1).content[0].text.split(rules[0]).length - 1, 1, 'rules appear exactly once')

  const normal = { purpose: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
  assert.equal(isCompactionRequest(normal), false)
  assert.equal(patchCompactionRequest(normal, rules), false)
  assert.equal(normal.messages.length, 1)
})

test('an immutable envelope is reported as unpatched rather than throwing', () => {
  const rules = resolveOptions({}).compactionRules
  const frozen = Object.freeze(compactionRequest())
  assert.equal(patchCompactionRequest(frozen, rules), false)
  assert.equal(isCompactionRequest(frozen), true, 'detection still works, so the listener can warn once')
})

test('the interceptor patches through the waterfall and always calls next', () => {
  const { ctx, registered } = stubContext({ used: 100000 })
  apply(ctx, {})
  const request = compactionRequest()
  let called = 0
  const result = registered.listeners['llm/stream'](request, () => {
    called += 1
    return 'stream'
  })
  assert.equal(called, 1)
  assert.equal(result, 'stream')
  assert.ok(messageText(request.messages.at(-1)).includes(DEFAULT_OPTIONS.compactionRules[0]))

  // A non-compaction request passes through untouched.
  const normal = { purpose: 'agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  registered.listeners['llm/stream'](normal, () => 'stream')
  assert.equal(messageText(normal.messages.at(-1)), 'hi')
})

test('the rules can be replaced or switched off', () => {
  const custom = resolveOptions({ compactionRules: ['- Custom rule.'] })
  assert.deepEqual(custom.compactionRules, ['- Custom rule.'])
  const request = compactionRequest()
  assert.equal(patchCompactionRequest(request, custom.compactionRules), true)
  assert.ok(messageText(request.messages.at(-1)).includes('- Custom rule.'))

  const { ctx, registered } = stubContext({ used: 1000 })
  apply(ctx, { patchCompactionPrompt: false })
  assert.ok(registered.variable, 'the measured line stays installed')
  // Installed but gated per request, so the settings switch is live: the request
  // passes through byte-identical while the capability is off.
  const off = compactionRequest()
  const before = JSON.stringify(off)
  registered.listeners['llm/stream'](off, () => 'stream')
  assert.equal(JSON.stringify(off), before)
})

test('a request that merely quotes the directive is not a compaction call', () => {
  const rules = resolveOptions({}).compactionRules
  // The shape that produced a false positive in the wild: an ordinary user turn
  // whose trailing tool result dumped the engine's own directive text.
  const lookAlike = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'grep the engine for the marker' }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `--- hit#1 type=tool/result at=1200/9000\n${INSTRUCTION}\n--- total hits: 10`,
          },
        ],
      },
    ],
  }
  assert.equal(isCompactionRequest(lookAlike), false)
  assert.equal(patchCompactionRequest(lookAlike, rules), false)
  assert.equal(messageText(lookAlike.messages.at(-1)).includes(rules[0]), false, 'nothing was appended')

  const quoted = {
    messages: [{ role: 'user', content: [{ type: 'text', text: `grep output: ${INSTRUCTION}` }] }],
  }
  assert.equal(isCompactionRequest(quoted), false)
  assert.equal(isTaggedCompactionRequest(quoted), false)
})

test('a caller tag is authoritative in both directions', () => {
  const rules = resolveOptions({}).compactionRules
  // Tagged as something else: never the compaction call, even though the trailing
  // message is the directive verbatim.
  const other = { ...compactionRequest(), purpose: 'session-title' }
  assert.equal(isCompactionRequest(other), false)
  assert.equal(patchCompactionRequest(other, rules), false)
  assert.equal(messageText(other.messages.at(-1)).includes(rules[0]), false)

  // Untagged: a directive-shaped tail is still recognised, so an engine that sets
  // no purpose at all keeps working.
  const untagged = compactionRequest()
  delete untagged.purpose
  assert.equal(isCompactionRequest(untagged), true)
  assert.equal(isTaggedCompactionRequest(untagged), false)
  assert.equal(patchCompactionRequest(untagged, rules), true)
  assert.ok(messageText(untagged.messages.at(-1)).includes(rules[0]))

  // A tagged call with no messages has nothing to patch.
  assert.equal(isCompactionRequest({ purpose: 'compaction', messages: [] }), false)
  assert.equal(isCompactionRequest({ purpose: 'compaction', messages: 'not an array' }), false)
})

test('a look-alike can no longer spend the one-shot warning', () => {
  const { ctx, registered } = stubContext({ used: 100000 })
  const warnings = []
  ctx.logger = { warn: (message) => warnings.push(message), info: () => {} }
  apply(ctx, {})
  const stream = registered.listeners['llm/stream']
  const next = () => 'stream'

  // An ordinary request with a frozen envelope that quotes the directive. This is
  // exactly what burned the warning in the wild, and it must stay silent.
  const lookAlike = Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: `excerpt: ${INSTRUCTION}` }]) }),
    ]),
  })
  assert.equal(stream(lookAlike, next), 'stream')
  assert.deepEqual(warnings, [], 'a look-alike must not warn')

  // A genuine tagged call it cannot patch: warns, exactly once.
  assert.equal(stream(Object.freeze(compactionRequest()), next), 'stream')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not extend the compaction directive/)
  stream(Object.freeze(compactionRequest()), next)
  assert.equal(warnings.length, 1, 'the warning stays one-shot')
})

test('a reading below one display step says so instead of rendering zero', () => {
  const { ctx, registered } = stubContext({ used: 35000 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /Context occupancy \(host-measured\): under 50K \/ 1\.00M tokens used \(under 5%\)/)
  assert.doesNotMatch(line, /: 0 \/ 1\.00M/, 'a sub-step reading must never render as an empty window')
  // The line must not contradict itself: 643K of real headroom, floored to 600K.
  assert.match(line, /About 600K tokens of headroom remain/)
})

test('an empty session still reads a true zero, and Chinese floors the same way', () => {
  const empty = stubContext({ used: 0 })
  apply(empty.ctx, {})
  assert.match(lineFor(empty.registered, stubSession()), /: 0 \/ 1\.00M tokens used \(0%\)/)

  const zh = stubContext({ used: 35000 })
  apply(zh.ctx, { language: 'zh' })
  assert.match(lineFor(zh.registered, stubSession()), /已用 不足 50K \/ 1\.00M（不足 5%）/)
})

test('a floored headroom names its own step instead of claiming zero', () => {
  const options = resolveOptions({})
  // A reading between one and two steps floors to one full step...
  assert.equal(headroomDisplayStep(15000, WINDOW, options), 10000)
  assert.equal(quantizeHeadroom(15000, WINDOW, options), 10000)
  // ...and a reading inside one step floors to zero, which renders as the step.
  assert.equal(quantizeHeadroom(2464, WINDOW, options), 0)
  const rendered = render(
    'tight',
    {
      quantized: 650000,
      step: 50000,
      used: 676000,
      window: WINDOW,
      threshold: THRESHOLD,
      percent: 65,
      headroom: 0,
      headroomRaw: 2464,
      headroomStep: 10000,
    },
    options,
  )
  assert.match(rendered, /Under 10K tokens of headroom remain before it\./)
  assert.doesNotMatch(rendered, /less than 1K/)
  assert.doesNotMatch(rendered, /0 tokens of headroom/)
})

test('the small bands define what the fold is, without ordering anything', () => {
  const options = resolveOptions({})
  const reading = {
    quantized: 650000,
    step: 50000,
    used: 652000,
    window: WINDOW,
    threshold: THRESHOLD,
    percent: 65,
    headroom: 20000,
    headroomRaw: 26464,
    headroomStep: 10000,
    steps: 5,
  }
  // A live model read `Under 10K ... remain before it` as "context left" and
  // answered "Very low context. I must do this in as few commands as possible."
  const tight = render('tight', reading, options)
  assert.match(tight, /The fold is routine, not the end of the window/)
  assert.match(tight, /work continues after it/)
  // A definition, not an instruction: nothing to do, nowhere to go.
  assert.doesNotMatch(tight, /hand off|must |should |wrap up/)

  // The band that already expects a fold gets only the half that defuses "exhausted".
  const critical = render('critical', { ...reading, headroom: 0, headroomRaw: 0, steps: 0 }, options)
  assert.match(critical, /The window is not exhausted — work continues after the fold\./)
  assert.doesNotMatch(critical, /fold is routine/)

  // Neither calm band needs the definition: the fold is not the subject there.
  assert.doesNotMatch(render('ample', reading, options), /not the end of the window/)
  assert.doesNotMatch(render('moderate', reading, options), /not the end of the window/)
  assert.doesNotMatch(render('tight', reading, { ...options, foldClause: false }), /fold is routine/)

  assert.equal(DEFAULT_OPTIONS.foldClause, true)
  assert.equal(resolveOptions({ foldClause: false }).foldClause, false)
  assert.equal(foldClause(false, options, true), ' The window is not exhausted — work continues after the fold.')
  assert.equal(foldClause(false, { ...options, foldClause: false }), '')
  assert.match(render('tight', reading, { ...options, language: 'zh' }), /折叠是例行操作，不是窗口的终点/)
})

test('the line answers "how much context is left" with the free window', () => {
  // The headroom figure answers "how far to the fold"; a live model answered the
  // other question with it and announced "Very low context" while 350K of the
  // window was free. Both figures now ride the line, and neither is removed.
  const tight = stubContext({ used: 652000 })
  apply(tight.ctx, {})
  const line = lineFor(tight.registered, stubSession())
  assert.match(line, /About 300K of the window is still free\./)
  assert.match(line, /About 20K tokens of headroom remain before it\./)

  // It rides every band: this is the anti-invention anchor, not a pressure warning.
  const calm = stubContext({ used: 300000 })
  apply(calm.ctx, {})
  assert.match(lineFor(calm.registered, stubSession()), /About 700K of the window is still free\./)

  // A remainder inside one display step says so instead of rendering a zero.
  const tiny = stubContext({ used: 980000 })
  apply(tiny.ctx, {})
  assert.match(lineFor(tiny.registered, stubSession()), /Under 50K of the window is still free\./)

  // Quantized onto the same step as `used`, so it adds no re-injection of its own.
  const freeOf = (used) => {
    const stub = stubContext({ used })
    apply(stub.ctx, {})
    return /About \d+K of the window is still free\./.exec(lineFor(stub.registered, stubSession()))[0]
  }
  assert.equal(freeOf(652000), freeOf(654000))

  const off = stubContext({ used: 652000 })
  apply(off.ctx, { freeClause: false })
  assert.doesNotMatch(lineFor(off.registered, stubSession()), /still free/)
  assert.equal(DEFAULT_OPTIONS.freeClause, true)
  assert.equal(resolveOptions({ freeClause: false }).freeClause, false)
  assert.match(
    render(
      'tight',
      { quantized: 650000, step: 50000, used: 652000, window: WINDOW, threshold: THRESHOLD, percent: 65, free: 300000, freeRaw: 348000 },
      { ...resolveOptions({}), language: 'zh' },
    ),
    /窗口还有约 300K 未使用。/,
  )
})

test('the first rule forbids quoting a budget claim and embeds none itself', () => {
  const rule = DEFAULT_COMPACTION_RULES[0]
  assert.match(rule, /not even quoted, paraphrased, or listed as an example/)
  assert.match(rule, /earlier checkpoint already carries one/)
  assert.equal(rule.includes('"'), false, 'the rule must not hand the model a quotable false claim')
  assert.match(DEFAULT_COMPACTION_RULES[1], /whose only justification was context pressure/)
})

// --- pace estimate ---------------------------------------------------------

/** Readings one step apart, each adding `step` tokens on top of `start`. */
function growth({ start, step, count, turn = 1 }) {
  return Array.from({ length: count }, (_, index) => ({ turn, step: index + 1, used: start + index * step }))
}

/** Drive the pure reducer over a sequence of step-boundary readings. */
function paceOver(readings, options = resolveOptions({})) {
  let result = nextPaceState(undefined, readings[0], options)
  for (const reading of readings.slice(1)) result = nextPaceState(result.state, reading, options)
  return result
}

test('the pace estimate needs real step boundaries and enough samples', () => {
  const options = resolveOptions({})
  const anchor = nextPaceState(undefined, { turn: 1, step: 1, used: 100000 }, options)
  assert.equal(anchor.perStep, undefined, 'the first reading can only anchor')
  assert.equal(anchor.samples, 0)

  const two = paceOver(growth({ start: 100000, step: 20000, count: 3 }), options)
  assert.equal(two.perStep, undefined, 'two deltas are still below paceMinSamples')
  assert.equal(two.samples, 2)

  const three = paceOver(growth({ start: 100000, step: 20000, count: 4 }), options)
  assert.equal(three.perStep, 20000)
  assert.equal(three.samples, 3)
})

test('a re-assembly inside one step is not mistaken for work', () => {
  const options = resolveOptions({})
  const settled = paceOver(growth({ start: 100000, step: 20000, count: 4 }), options)
  assert.equal(settled.perStep, 20000)

  // Same step assembled again, with the reading moved by a tool result.
  const again = nextPaceState(settled.state, { turn: 1, step: 4, used: 900000 }, options)
  assert.equal(again.perStep, 20000, 'the estimate must not move inside a step')
  assert.equal(again.state.used, 160000, 'the sampled reading must not move inside a step')
})

test('a fold re-base drops the pace history instead of poisoning it', () => {
  const options = resolveOptions({})
  const before = paceOver(growth({ start: 600000, step: 20000, count: 4 }), options)
  assert.equal(before.perStep, 20000)

  // The meter re-bases when a fold lands: the next reading is far below the last.
  const folded = nextPaceState(before.state, { turn: 1, step: 5, used: 24000 }, options)
  assert.equal(folded.perStep, undefined, 'the estimate must disappear until it is re-earned')
  assert.equal(folded.samples, 0, 'pre-fold deltas must not survive the fold')

  const rebuilt = paceOver(
    [
      { turn: 1, step: 5, used: 24000 },
      { turn: 1, step: 6, used: 44000 },
      { turn: 1, step: 7, used: 64000 },
      { turn: 1, step: 8, used: 84000 },
    ],
    options,
  )
  assert.equal(rebuilt.perStep, 20000, 'post-fold steps rebuild the estimate from scratch')
})

test('one large tool dump does not move the estimate', () => {
  const options = resolveOptions({})
  const steady = paceOver(growth({ start: 0, step: 10000, count: 7 }), options)
  assert.equal(steady.perStep, 10000)
  assert.equal(steady.samples, 6)

  const spiked = nextPaceState(steady.state, { turn: 1, step: 8, used: steady.state.used + 90000 }, options)
  assert.equal(spiked.perStep, 10000, 'the median absorbs a single 90K step')
  assert.equal(spiked.samples, 7)

  const long = paceOver(growth({ start: 0, step: 10000, count: 20 }), options)
  assert.equal(long.samples, options.paceSamples, 'the ring buffer stays bounded')
})

test('a step that added nothing says nothing about pace', () => {
  const options = resolveOptions({})
  const steady = paceOver(growth({ start: 100000, step: 20000, count: 4 }), options)
  const flat = nextPaceState(steady.state, { turn: 1, step: 5, used: steady.state.used }, options)
  assert.equal(flat.perStep, 20000)
  assert.equal(flat.samples, 3, 'a zero delta is neither work nor a re-base')
})

test('samplePace keeps per-session state and honours the switch', () => {
  const options = resolveOptions({})
  const store = new Map()
  const session = {}
  const assembly = { agent: { phase: { turn: 1, step: 1 } } }
  assert.equal(samplePace(store, session, assembly, 100000, options), undefined)
  assert.equal(store.get(session).used, 100000)
  assert.equal(samplePace(store, session, assembly, 100000, { ...options, paceEstimate: false }), undefined)
  assert.equal(samplePace(store, session, { agent: {} }, 100000, options), undefined, 'no counter, no state move')
  const other = {}
  assert.equal(samplePace(store, other, { agent: {} }, 100000, options), undefined)
  assert.equal(store.get(other), undefined, 'a session without a counter stores nothing')
})

test('the step count floors and refuses nonsense', () => {
  assert.equal(paceSteps(78464, 20000), 3)
  assert.equal(paceSteps(19999, 20000), 0)
  assert.equal(paceSteps(undefined, 20000), undefined)
  assert.equal(paceSteps(1000, 0), undefined)
  assert.equal(paceSteps(1000, -5), undefined)
})

test('the estimate rides only on the two bands that ask about headroom', () => {
  const options = resolveOptions({})
  const reading = {
    quantized: 300000,
    step: 50000,
    used: 300000,
    window: WINDOW,
    threshold: THRESHOLD,
    percent: 30,
    headroom: 378000,
    headroomRaw: 378464,
    headroomStep: 50000,
    steps: 6,
  }
  assert.doesNotMatch(render('ample', reading, options), /more step/)
  assert.doesNotMatch(render('moderate', reading, options), /more step/)
  assert.match(render('tight', reading, options), /roughly 5 more steps/)
  assert.match(render('critical', reading, options), /roughly 5 more steps/)
})

test('the rungs are coarse and round down, and a lone step reads as one step', () => {
  assert.equal(paceSentence(0, false), '')
  assert.equal(paceSentence(1, false), " At this session's recent rate that is roughly 1 more step.")
  assert.equal(paceSentence(2, false), " At this session's recent rate that is roughly 2 more steps.")
  assert.equal(paceSentence(6, false), " At this session's recent rate that is roughly 5 more steps.")
  assert.equal(paceSentence(19, false), " At this session's recent rate that is roughly 13 more steps.")
  assert.equal(paceSentence(20, false), " At this session's recent rate that is roughly 20+ more steps.")
  assert.equal(paceSentence(40, false), " At this session's recent rate that is roughly 20+ more steps.")
  assert.equal(paceSentence(3, true), ' 按本会话近期节奏，这点余量约合 3 步。')
  assert.deepEqual(PACE_LADDER, [1, 2, 3, 5, 8, 13, 20])
  assert.equal(median([]), undefined)
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('a straddling estimate no longer flips the published rung', () => {
  const options = resolveOptions({})
  // The raw step counts behind the five commits observed in one live session:
  // they straddled the old 21/34 boundary and flipped the line four times.
  const rendered = []
  let state
  for (const steps of [38, 23, 35, 24, 34]) {
    const settled = settlePace(steps, state, options)
    state = settled.state
    rendered.push(settled.steps)
  }
  assert.deepEqual(rendered, [20, 20, 20, 20, 20])
  assert.equal(new Set(rendered).size, 1, 'one rung means no pace-driven snapshot churn')
})

test('the rung drops at once and rises only past the margin', () => {
  const options = resolveOptions({})
  const first = settlePace(38, undefined, options)
  assert.equal(first.steps, 20)
  assert.equal(settlePace(38, first.state, options).steps, 20)

  // Less room is never held back: a drop publishes immediately.
  const down = settlePace(9, first.state, options)
  assert.equal(down.steps, 8)

  // Upward needs 20 * 1.25 = 25 to be promised again.
  assert.equal(settlePace(24, down.state, options).steps, 8, 'a straddling estimate holds')
  const up = settlePace(25, down.state, options)
  assert.equal(up.steps, 20, 'a sustained change is still published — the rule cannot freeze')
  assert.equal(settlePace(15, up.state, options).steps, 13)
  assert.equal(settlePace(undefined, up.state, options).steps, undefined)
  assert.equal(settlePace(0, up.state, options).steps, undefined)

  assert.equal(paceRung(0), undefined)
  assert.equal(paceRung(1), 0)
  assert.equal(paceRung(19), 5)
  assert.equal(paceRung(20), 6)
  assert.equal(paceRung(9999), 6)
  assert.equal(DEFAULT_OPTIONS.paceMargin, 0.25)
  assert.equal(resolveOptions({ paceMargin: 0 }).paceMargin, 0)
  // A wider margin needs a louder signal before promising more room.
  assert.equal(settlePace(26, down.state, resolveOptions({ paceMargin: 0.5 })).steps, 8)
})

test('with no estimate the published line is unchanged', () => {
  const session = stubSession()
  const lineAt = (config, withPhase) => {
    let used = 0
    const meter = { measure: () => ({ totalTokens: used }) }
    const { ctx, registered } = stubContext({ meter })
    apply(ctx, config)
    let line = ''
    for (let step = 1; step <= 7; step += 1) {
      used = 480000 + (step - 1) * 20000
      const agent = withPhase ? { session, phase: { turn: 1, step } } : { session }
      line = registered.variable.provider({ agent })
    }
    return line
  }
  const none = lineAt({}, false)
  assert.match(none, /600K \/ 1\.00M tokens used \(60%\)/)
  assert.doesNotMatch(none, /more step/)
  assert.equal(lineAt({ paceEstimate: false }, true), none, 'the switch off must render the old line byte for byte')
  assert.equal(lineAt({ paceEstimate: true }, true).includes('more steps'), true)
})

test('the tight band asks for nothing by default and offers both older wordings', () => {
  const options = resolveOptions({})
  const reading = {
    quantized: 600000,
    step: 50000,
    used: 600000,
    window: WINDOW,
    threshold: THRESHOLD,
    percent: 60,
    headroom: 70000,
    headroomRaw: 78464,
    headroomStep: 10000,
    steps: 3,
  }

  // Default: the numbers are the message. A fold notice here made a live model
  // narrate compaction every step or two, so it is gone by default.
  const none = render('tight', reading, options)
  assert.equal(tightClause(false, options), '')
  assert.doesNotMatch(none, /folded into an LLM-written summary/)
  assert.doesNotMatch(none, /hand off/)
  assert.doesNotMatch(none, /finish the current step/)
  assert.doesNotMatch(none, /genuinely small/)
  // The facts that make the decision possible are all still there.
  assert.match(none, /Automatic compaction fires at 678K/)
  assert.match(none, /About 70K tokens of headroom remain before it\./)
  assert.match(none, /roughly 3 more steps/)
  assert.match(none, /Background telemetry from the host/)

  const inform = render('tight', reading, { ...options, tightAdvice: 'inform' })
  assert.match(inform, /At that point the older turns are folded into an LLM-written summary/)
  assert.match(inform, /keep nothing critical only in the conversation/)
  assert.doesNotMatch(inform, /hand off/)

  const stop = render('tight', reading, { ...options, tightAdvice: 'stop' })
  assert.match(stop, /Headroom is genuinely small — finish the current step, land durable state, then hand off\./)

  const zh = render('tight', reading, { ...options, language: 'zh' })
  assert.doesNotMatch(zh, /会被折成一段 LLM 摘要/)
  assert.doesNotMatch(zh, /再考虑交接/)
  assert.doesNotMatch(zh, /余量确实不多了/)
  assert.match(zh, /本行是宿主的后台遥测/)
  assert.match(zh, /不要自行倒计时/)
  assert.match(render('tight', reading, { ...options, language: 'zh', tightAdvice: 'inform' }), /会被折成一段 LLM 摘要/)
  assert.match(render('tight', reading, { ...options, language: 'zh', tightAdvice: 'stop' }), /再考虑交接/)

  // `critical` states the fact that a fold is at hand, and keeps doing so.
  assert.match(render('critical', reading, options), /At or past the automatic compaction point/)

  assert.equal(resolveOptions({ tightAdvice: 'stop' }).tightAdvice, 'stop')
  assert.equal(resolveOptions({ tightAdvice: 'inform' }).tightAdvice, 'inform')
  assert.equal(resolveOptions({ tightAdvice: 'nonsense' }).tightAdvice, 'none')
  assert.equal(DEFAULT_OPTIONS.tightAdvice, 'none')
})

test('the registered provider turns a session pace into the rendered clause', () => {
  let used = 0
  const meter = { measure: () => ({ totalTokens: used }) }
  const { ctx, registered } = stubContext({ meter })
  apply(ctx, {})
  const session = stubSession()
  let line = ''
  for (let step = 1; step <= 7; step += 1) {
    used = 480000 + (step - 1) * 20000
    line = registered.variable.provider({ agent: { session, phase: { turn: 1, step } } })
  }
  // 600K of a 678,464 point, growing 20K per step → 78,464 floors to three steps.
  assert.match(line, /Context occupancy \(host-measured\): 600K \/ 1\.00M tokens used \(60%\)/)
  assert.match(line, /About 70K tokens of headroom remain before it\./)
  assert.match(line, /roughly 3 more steps/)
  assert.match(line, /Background telemetry from the host/)
  assert.doesNotMatch(line, /folded into an LLM-written summary/)

  const zh = stubContext({ meter })
  apply(zh.ctx, { language: 'zh' })
  let zhLine = ''
  for (let step = 1; step <= 7; step += 1) {
    used = 480000 + (step - 1) * 20000
    zhLine = zh.registered.variable.provider({ agent: { session, phase: { turn: 1, step } } })
  }
  assert.match(zhLine, /按本会话近期节奏，这点余量约合 3 步。/)
})

/** Let a listener's microtask chain run before asserting on its effects. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the idle fold fires at the turn boundary once the room runs out', async () => {
  const calls = []
  const compaction = {
    compactNow: (...args) => {
      calls.push(args)
      return Promise.resolve()
    },
  }
  const session = stubSession()

  // 640K of a 1M window with the point at 678,464 → 38,464 of headroom, inside the
  // 5% (50K) default margin: exactly the state that turns turns into short sprints.
  const near = stubContext({ used: 640000, compaction })
  apply(near.ctx, { foldAtIdle: true })
  const onStatus = near.registered.listeners['agent/status']
  assert.equal(typeof onStatus, 'function', 'foldAtIdle must subscribe to agent/status')

  // Only the idle boundary folds: a running agent is mid-turn and must be left alone.
  onStatus({ agent: { session }, status: 'running' })
  await tick()
  assert.equal(calls.length, 0)

  onStatus({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1, 'the idle fold must call compaction.compactNow')
  assert.equal(calls[0][0].session, session)
  assert.ok(calls[0][1] !== undefined, 'compactNow must receive an abort signal')

  // Rate-limited: an in-flight or just-attempted fold is not repeated.
  onStatus({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1)

  // Plenty of room: the trigger stays out of the way entirely.
  const calm = stubContext({ used: 300000, compaction: { compactNow: () => (calls.push(['calm']), Promise.resolve()) } })
  apply(calm.ctx, { foldAtIdle: true })
  calm.registered.listeners['agent/status']({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1, 'a calm session must not fold')

  // Default mode is `idle`: a config nobody touched folds at the turn boundary,
  // which is the behaviour this plugin always had behind `foldAtIdle: true`.
  const byDefault = stubContext({ used: 640000, compaction })
  apply(byDefault.ctx, {})
  assert.equal(typeof byDefault.registered.listeners['agent/status'], 'function')
  byDefault.registered.listeners['agent/status']({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 2, 'the default mode folds at the turn boundary')

  // Explicitly off: the listener exists (so the switch is live) but never folds.
  const off = stubContext({ used: 640000, compaction })
  apply(off.ctx, { foldMode: 'off' })
  assert.equal(typeof off.registered.listeners['agent/status'], 'function')
  off.registered.listeners['agent/status']({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 2, 'an explicit off must not fold anything')

  // The pure decision, including the band where the fold must not fire.
  const options = resolveOptions({ foldAtIdle: true })
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, options).fold, true)
  assert.equal(shouldFoldAtIdle({ used: 620000, threshold: THRESHOLD, window: WINDOW }, options).fold, false)
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: undefined, window: WINDOW }, options).fold, false)
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, resolveOptions({ foldMode: 'off' })).fold, false)
  assert.equal(DEFAULT_OPTIONS.foldMode, 'idle', 'the automatic idle fold is the default')
})

test('an idle fold never breaks a turn', async () => {
  const logs = []
  const boom = stubContext({
    used: 640000,
    logs,
    compaction: { compactNow: () => Promise.reject(new Error('engine busy')) },
  })
  apply(boom.ctx, { foldAtIdle: true })
  boom.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  await tick()
  assert.ok(
    logs.some(([, message]) => String(message).includes('idle fold failed')),
    'a failed fold must be logged, not thrown',
  )

  // No compaction service at all: warn once and keep the turn alive.
  const bare = stubContext({ used: 640000, logs })
  apply(bare.ctx, { foldAtIdle: true })
  bare.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  bare.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  await tick()
  const warns = logs.filter(([, message]) => String(message).includes('nor a reachable compaction service answered'))
  assert.equal(warns.length, 1, 'the missing-service warning must be one-shot')
})

test('every schema default matches DEFAULT_OPTIONS', () => {
  // Adding the settings schema silently switched capability 2 off once: the host
  // materializes a field with no schema default as `[]`, and `[]` means "append
  // nothing" for the compaction rules. The invariant this guards is that a config
  // the form never touches behaves exactly like no config at all.
  const write = Symbol.for('cosmokit.volatile.write')
  const plain = (value) =>
    value !== null && typeof value === 'object' && write in value && typeof value.get === 'function'
      ? plain(value.get())
      : value

  const fromSchema = resolveOptions(Config({}))
  const fromNothing = resolveOptions({})
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    assert.deepEqual(
      fromSchema[key],
      fromNothing[key],
      `schema default for "${key}" must match DEFAULT_OPTIONS`,
    )
  }
  assert.equal(plain(Config({}).compactionRules).length, DEFAULT_COMPACTION_RULES.length)
  assert.ok(DEFAULT_COMPACTION_RULES.length > 0, 'the shipped rules must not be empty')
})

test('the idle fold reaches the compaction service wired by inject', async () => {
  // Two live designs failed to get the service — `ctx.get('compaction')` and
  // `ctx.inject(['compaction'], cb)` — so it comes from the declared injection and
  // is read off the context, per use rather than snapshotted.
  const calls = []
  const first = { compactNow: (...args) => (calls.push(['first', ...args]), Promise.resolve()) }
  const stub = stubContext({ used: 640000, compaction: first })
  stub.ctx.compaction = first
  stub.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(stub.ctx, { foldAtIdle: true })

  const second = { compactNow: (...args) => (calls.push(['second', ...args]), Promise.resolve()) }
  // Resolved per use, so a provider that arrives (or is replaced) after apply is
  // followed. Both reads are swapped: the stub answers `get` and the property
  // independently, and the resolution prefers whichever carries `compactNow`.
  const meter = { measure: () => ({ totalTokens: 640000 }) }
  stub.ctx.get = (key) => (key === 'compaction' ? second : key === 'tokenMeter' ? meter : undefined)
  stub.ctx.compaction = second

  stub.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1, 'the trigger must reach the wired service')
  assert.equal(calls[0][0], 'second', 'the service must be resolved per use, not snapshotted')

  // The meter comes from the same wiring, and the reading proves it: 640,000 used
  // (shown as the 600K display step) is inside the 5% margin of the 678,464 point,
  // and a missing meter would render "no reading yet" instead.
  const line = stub.registered.variable.provider({ agent: { session: stubSession() } })
  assert.match(line, /600K \/ 1\.00M tokens used \(60%\)/)
  assert.match(line, /About 30K tokens of headroom remain/)
})

test('a live settings change reaches the plugin without a reload', async () => {
  // The host stores every `.volatile()` field as a reference cell and commits a
  // settings change into it in place (`loader._commitVolatile`), so options
  // snapshotted at apply time would silently ignore the toggle. Build the cell
  // shape the host uses and prove the plugin follows it.
  const write = Symbol.for('cosmokit.volatile.write')
  const cell = (initial) => {
    let current = initial
    return { get: () => current, [write]: (next) => (current = next) }
  }

  const freeClause = cell(true)
  const { ctx, registered } = stubContext({ used: 652000 })
  apply(ctx, { freeClause })
  const line = () => registered.variable.provider({ agent: { session: stubSession() } })
  assert.match(line(), /of the window is still free/)

  freeClause[write](false) // what the settings page does to the running reference
  assert.doesNotMatch(line(), /still free/)
  freeClause[write](true)
  assert.match(line(), /of the window is still free/)

  // And the fold switch follows the same path: flipped at runtime, it arms.
  const calls = []
  const foldAtIdle = cell(false)
  const armed = stubContext({
    used: 640000,
    compaction: { compactNow: (...args) => (calls.push(args), Promise.resolve()) },
  })
  apply(armed.ctx, { foldAtIdle })
  const idle = () => armed.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  idle()
  await tick()
  assert.equal(calls.length, 0, 'a switched-off fold must not fire')

  foldAtIdle[write](true)
  idle()
  await tick()
  assert.equal(calls.length, 1, 'flipping the switch at runtime must arm the fold')
  assert.equal(resolveOptions({ freeClause }).freeClause, true, 'resolveOptions must unwrap a reference cell')
})

test('the backend identity names the mounted engine', () => {
  // Which backend owns the seam decides whether a fold can be requested at all and
  // whether capability 2 has anything to patch, so the startup line reports it.
  class CompactionEngine {}
  class BasicCompactionEngine extends CompactionEngine {}
  class DcpEngine extends BasicCompactionEngine {}
  assert.equal(backendIdentity(new DcpEngine()), 'DcpEngine>BasicCompactionEngine>CompactionEngine')
  assert.equal(backendIdentity(undefined), 'none')
  assert.equal(backendIdentity('not injected'), 'none', 'cordis answers with a string when unreachable')
  assert.equal(backendIdentity({}), 'anonymous')
  assert.equal(backendIdentity(null), 'none')
})

test('the idle fold prefers the realm /compact command and falls back to the service', async () => {
  // `commands.execute(agent, '/compact', …)` runs the fold through the AGENT's
  // realm view, so it lands on whichever backend that agent mounts — the only
  // channel that works on a stock deployment (a profile-scope plugin cannot inject
  // a preset realm's compaction service: upstream discussion 9425).
  const called = []
  const agent = { session: stubSession() }
  const commands = { execute: (...args) => (called.push(['command', ...args]), Promise.resolve({ kind: 'completed' })) }
  const service = { compactNow: (...args) => (called.push(['service', ...args]), Promise.resolve()) }

  const viaCommand = stubContext({ used: 640000, compaction: service, commands })
  viaCommand.ctx.compaction = service
  viaCommand.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(viaCommand.ctx, { foldAtIdle: true })
  viaCommand.registered.listeners['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.equal(called.length, 1, 'the command channel must be tried first')
  assert.equal(called[0][0], 'command')
  assert.equal(called[0][2], '/compact')
  assert.deepEqual(called[0][3], [], 'submitted attachments must be an empty list')
  assert.ok(called[0][4] !== undefined, 'the command must receive an abort signal')

  // A realm that refuses (or mounts no compact) must not silence the fold.
  called.length = 0
  const refusing = stubContext({
    used: 640000,
    compaction: service,
    commands: { execute: (...args) => (called.push(['command', ...args]), Promise.reject(new Error('no such command'))) },
  })
  refusing.ctx.compaction = service
  refusing.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(refusing.ctx, { foldAtIdle: true })
  refusing.registered.listeners['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.deepEqual(called.map((entry) => entry[0]), ['command', 'service'], 'the service must answer when the command cannot')

  // `service` skips the command entirely.
  called.length = 0
  const direct = stubContext({ used: 640000, compaction: service, commands })
  direct.ctx.compaction = service
  direct.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(direct.ctx, { foldAtIdle: true, foldAtIdleMethod: 'service' })
  direct.registered.listeners['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.deepEqual(called.map((entry) => entry[0]), ['service'])

  // `command` never touches the service, even when one is reachable.
  called.length = 0
  const onlyCommand = stubContext({ used: 640000, compaction: service, commands })
  onlyCommand.ctx.compaction = service
  onlyCommand.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(onlyCommand.ctx, { foldAtIdle: true, foldAtIdleMethod: 'command' })
  onlyCommand.registered.listeners['agent/status']({ agent, status: 'idle' })
  await tick()
  assert.deepEqual(called.map((entry) => entry[0]), ['command'])
  assert.equal(DEFAULT_OPTIONS.foldAtIdleMethod, 'auto')
})

test('a diagnostic string from the property read never shadows a working service', async () => {
  // `ctx.compaction` answers with a string when this fiber lacks the service, while
  // `ctx.get('compaction')` can still resolve it. Treating the string as "found"
  // skipped the candidate that worked and the fold silently stopped firing.
  const calls = []
  const service = { compactNow: (...args) => (calls.push(args), Promise.resolve()) }
  const stub = stubContext({ used: 640000 })
  stub.ctx.get = (key) => (key === 'compaction' ? service : key === 'tokenMeter' ? { measure: () => ({ totalTokens: 640000 }) } : undefined)
  stub.ctx.compaction = 'service "compaction" has not been injected' // the diagnostic string
  stub.ctx.tokenMeter = { measure: () => ({ totalTokens: 640000 }) }
  apply(stub.ctx, { foldAtIdle: true, foldAtIdleMethod: 'service' })
  stub.registered.listeners['agent/status']({ agent: { session: stubSession() }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1, 'the reachable service must win over the diagnostic string')
})

// ---------------------------------------------------------------------------
// Capability 3: foldMode 'handoff'
//
// The state machine has more ways to stop than to proceed, so every stop is
// asserted with the same weight as the happy path: a fold that silently does not
// happen is the failure this mode exists to remove, and one that happens when it
// should not is worse.
// ---------------------------------------------------------------------------

/** A root-session fixture carrying the header the handoff state keys on. */
function handoffSession(id = 'session-handoff-1', { depth = 0 } = {}) {
  return {
    id,
    header: { id, delegationDepth: depth },
    requestContext: () => ({ contextWindow: WINDOW }),
    requestHeader: () => ({ config: { maxTokens: MAX_TOKENS } }),
  }
}

/** A live-agent fixture recording what the plugin injects and activates. */
function handoffAgent(session) {
  const agent = {
    status: 'running',
    session,
    injected: [],
    followed: [],
    inject: (message) => agent.injected.push(message),
    followup: (message) => agent.followed.push(message),
  }
  return agent
}

/** A token meter a test can move between steps. */
function movableMeter(used) {
  const box = { used }
  return { box, meter: { measure: () => ({ totalTokens: box.used }) } }
}

/** Fire the composed `agent/request` waterfall at one step. */
function requestStep(registered, agent, turn, step = 1) {
  const listener = registered.listeners['agent/request']
  assert.equal(typeof listener, 'function', 'handoff mode must subscribe to agent/request')
  return listener({ agent, turn, step, signal: {} }, () => Promise.resolve({}))
}

/** Fire the composed `agent/status` listeners at an idle boundary and settle them. */
async function idleBoundary(registered, agent) {
  registered.listeners['agent/status']({ agent, status: 'idle' })
  await tick()
  await tick()
}

/** A scratch handoff root that the test removes afterwards. */
function scratchRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ct-handoff-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('foldMode: absent means idle, an explicit opt-out or mode wins', () => {
  assert.equal(DEFAULT_OPTIONS.foldMode, 'idle', 'the automatic idle fold is the default')
  assert.equal(resolveOptions({}).foldMode, 'idle')
  assert.equal(resolveOptions({ foldAtIdle: true }).foldMode, 'idle', 'the legacy switch means the same thing as the default')
  assert.equal(resolveOptions({ foldAtIdle: false }).foldMode, 'off', 'an explicit opt-out is honoured')
  assert.equal(resolveOptions({ foldAtIdle: true, foldMode: 'off' }).foldMode, 'off', 'an explicit mode beats the alias')
  assert.equal(resolveOptions({ foldAtIdle: false, foldMode: 'handoff' }).foldMode, 'handoff')
  assert.equal(resolveOptions({ foldMode: 'nonsense' }).foldMode, 'idle', 'an unknown value degrades to the default')

  // The schema is the first line of defence, and the mode is decided by the
  // RESOLVED value, not by key presence: `.volatile()` materializes the key as a
  // reference cell even when the user never set it, so presence proves nothing.
  // What must hold is that a config the user never touched resolves to `idle`,
  // an explicit `foldAtIdle: false` still opts out, through the real schema.
  assert.throws(() => Config({ foldMode: 'nonsense' }))
  assert.equal(resolveOptions(Config({})).foldMode, 'idle')
  assert.equal(resolveOptions(Config({ foldAtIdle: false })).foldMode, 'off')
  assert.equal(resolveOptions(Config({ foldAtIdle: true })).foldMode, 'idle')
  assert.equal(resolveOptions(Config({ foldMode: 'off' })).foldMode, 'off')
  assert.equal(resolveOptions(Config({ foldMode: 'handoff' })).foldMode, 'handoff')

  // One gate decides both spellings, so handoff mode can never also idle-fold.
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, resolveOptions({ foldMode: 'handoff' })).fold, false)
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, resolveOptions({ foldMode: 'idle' })).fold, true)
})

test('the handoff tool follows the live fold mode', async (t) => {
  const root = scratchRoot(t)
  const { meter } = movableMeter(600000)
  const agent = handoffAgent(handoffSession('session-tool'))
  const config = { foldMode: 'off', handoffDir: root }
  const { ctx, registered } = stubContext({ meter, compaction: { compactNow: () => Promise.resolve({}) } })
  const hasTool = () => registered.tools.some((definition) => definition.name === HANDOFF_TOOL_NAME)

  apply(ctx, config)
  assert.equal(hasTool(), false, 'off mode must not advertise handoff_ready')

  config.foldMode = 'idle'
  await requestStep(registered, agent, 1)
  assert.equal(hasTool(), false, 'idle mode must not advertise handoff_ready')

  config.foldMode = 'handoff'
  await requestStep(registered, agent, 2)
  assert.equal(hasTool(), true, 'handoff mode must register the tool on the next request')

  config.foldMode = 'off'
  await requestStep(registered, agent, 3)
  assert.equal(hasTool(), false, 'switching away must remove it again')

  // Teardown must not leave the row behind: the registration lives on the tools
  // service's layer, so only the returned disposer (or this cleanup) removes it.
  config.foldMode = 'handoff'
  await requestStep(registered, agent, 4)
  assert.equal(hasTool(), true)
  for (const dispose of registered.disposers.slice().reverse()) dispose()
  assert.equal(hasTool(), false, 'disposing the plugin must unregister the tool')
})

test('handoff notes live under $DSH_HOME, one directory per session, never the workspace', () => {
  const env = { DSH_HOME: join(tmpdir(), 'ct-home') }
  const base = resolveOptions({ foldMode: 'handoff' })
  assert.equal(handoffRoot(base, env), join(env.DSH_HOME, 'handoffs'))
  assert.equal(handoffRoot(resolveOptions({ foldMode: 'handoff', handoffDir: 'notes-test' }), env), join(env.DSH_HOME, 'notes-test'))
  const absolute = join(tmpdir(), 'ct-absolute')
  assert.equal(handoffRoot(resolveOptions({ foldMode: 'handoff', handoffDir: absolute }), env), absolute)
  // No DSH_HOME in the environment → ~/.dsh, which is still not the workspace.
  assert.equal(handoffRoot(base, {}), join(homedir(), '.dsh', 'handoffs'))

  const root = join(tmpdir(), 'ct-h')
  assert.equal(handoffPathFor(root, 'session-abc', 1), join(root, 'session-abc', '001.handoff.md'))
  assert.ok(handoffPathFor(root, 'session-abc', 42).endsWith('042.handoff.md'))

  // A session id cannot climb out of its own directory, and an empty one is named.
  const segment = safeSegment('../../etc/passwd')
  assert.equal(/[\\/]/.test(segment), false)
  assert.equal(segment.startsWith('.'), false)
  assert.equal(safeSegment(''), 'unknown-session')

  // The identity comes from the header first, which is the id the store uses.
  assert.equal(sessionIdOf({ id: 'from-body', header: { id: 'from-header' } }), 'from-header')
  assert.equal(sessionIdOf({ id: 'from-body' }), 'from-body')
  assert.equal(sessionIdOf({}), '')
})

test('the prep point is a fraction of the fold point, and only handoff mode prepares', () => {
  const options = resolveOptions({ foldMode: 'handoff' })
  const point = Math.round(THRESHOLD * 0.85)
  assert.equal(handoffTrigger({ used: 580000, threshold: THRESHOLD, window: WINDOW }, options).point, point)
  assert.equal(handoffTrigger({ used: point, threshold: THRESHOLD, window: WINDOW }, options).prepare, true)
  assert.equal(handoffTrigger({ used: point - 1, threshold: THRESHOLD, window: WINDOW }, options).prepare, false)
  assert.equal(handoffTrigger({ used: 1e6 }, options).prepare, false, 'no fold point, no prep')
  assert.equal(handoffTrigger({ used: 1e6, threshold: THRESHOLD }, resolveOptions({})).prepare, false)
  assert.equal(handoffTrigger({ used: 1e6, threshold: THRESHOLD }, resolveOptions({ foldAtIdle: true })).prepare, false, 'idle mode must not prepare')

  // The configured fraction is honoured and clamped to the documented range.
  const at = (value) => handoffTrigger({ used: 1, threshold: THRESHOLD }, resolveOptions({ foldMode: 'handoff', handoffAt: value })).point
  assert.equal(at(0.85), point)
  assert.equal(at(0.1), Math.round(THRESHOLD * 0.5))
  assert.equal(at(0.99), Math.round(THRESHOLD * 0.95))

  // Both messages name the note and the temporary-file warning; the prepare line
  // also says where in the fold the session is standing.
  const path = handoffPathFor(join(tmpdir(), 'h'), 'session-abc', 3)
  const trigger = handoffTrigger({ used: 600000, threshold: THRESHOLD, window: WINDOW }, options)
  const zhOptions = resolveOptions({ foldMode: 'handoff', language: 'zh' })
  const zhPrep = handoffPrepMessage({ path, trigger, recycled: 2, options: zhOptions })
  assert.ok(zhPrep.includes(path))
  assert.match(zhPrep, new RegExp(`${Math.round((600000 / THRESHOLD) * 100)}%`))
  assert.match(zhPrep, /临时文件/)
  assert.match(zhPrep, /handoff_ready/)
  assert.match(zhPrep, /2/)
  const enOptions = resolveOptions({ foldMode: 'handoff' })
  const enPrep = handoffPrepMessage({ path, trigger, recycled: 0, options: enOptions })
  assert.ok(enPrep.includes(path))
  assert.match(enPrep, /temporary file/)
  const enActivation = handoffActivationMessage({ path, foldNo: 1, options: enOptions })
  assert.ok(enActivation.includes(path))
  assert.match(enActivation, /only auto-activated turn/)
})

test('handoff mode folds at the round end and activates exactly one turn', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(500000)
  const folds = []
  const logs = []
  const session = handoffSession('session-happy')
  const agent = handoffAgent(session)
  const { ctx, registered } = stubContext({
    meter,
    logs,
    compaction: {
      compactNow: (...args) => {
        folds.push(args)
        return Promise.resolve({ shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 2 })
      },
    },
  })
  apply(ctx, { foldMode: 'handoff', handoffDir: root, language: 'zh' })

  // Below the prep point: no reminder, no tool call, nothing.
  await requestStep(registered, agent, 1)
  assert.equal(agent.injected.length, 0)

  // Crossing it injects one reminder naming the exact path.
  box.used = 600000
  await requestStep(registered, agent, 2, 1)
  assert.equal(agent.injected.length, 1, 'the prep reminder must be injected')
  const notePath = handoffPathFor(root, 'session-happy', 1)
  const prepText = agent.injected[0].content[0].text
  assert.ok(prepText.includes(notePath), 'the reminder must name the exact path')
  assert.equal(agent.injected[0].role, 'user')
  assert.equal(agent.injected[0].source.kind, 'user')

  // One per turn, even though the waterfall runs on every step.
  await requestStep(registered, agent, 2, 2)
  await requestStep(registered, agent, 2, 3)
  assert.equal(agent.injected.length, 1)

  // The tool refuses a note that does not exist yet.
  const tool = registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  assert.ok(tool !== undefined, 'handoff mode must register handoff_ready')
  assert.equal(tool.output.render([], 'x')[0].text, 'x')
  assert.match(tool.execute({}, { agent }), /还没有文件/)

  // Write the note, register it.
  mkdirSync(join(root, 'session-happy'), { recursive: true })
  writeFileSync(notePath, `# 交接档\n${'x'.repeat(400)}`, 'utf8')
  const registeredText = tool.execute({ path: notePath }, { agent })
  assert.match(registeredText, /✓ 交接档已登记/)
  assert.ok(registeredText.includes(notePath))

  // The round ends: fold once, activate once.
  await idleBoundary(registered, agent)
  assert.equal(folds.length, 1, 'the round end must fold')
  assert.ok(folds[0][1] !== undefined, 'compactNow must receive an abort signal')
  assert.equal(agent.followed.length, 1, 'exactly one activation turn')
  const activation = agent.followed[0].content[0].text
  assert.ok(activation.includes(notePath))
  assert.match(activation, /唯一一次自动激活/)
  assert.equal(agent.followed[0].source.kind, 'user')

  // A second idle boundary activates nothing more, and the fold is not repeated.
  // A real fold drops the reading below the prep point, which is what keeps the
  // reminder (and its wake) out of the activation round.
  box.used = 100000
  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 1)
  assert.equal(folds.length, 1)

  // The state is durable, and it says exactly what happened.
  const state = JSON.parse(readFileSync(join(root, 'session-happy', HANDOFF_STATE_FILE), 'utf8'))
  assert.equal(state.foldNo, 1)
  assert.equal(state.ready, null)
  assert.equal(state.pending.foldNo, 1)
  assert.ok(state.pending.deliveredAt > 0)
})

test('a round that ends past the prep point wakes one reminder turn, bounded by the budget', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const folds = []
  const logs = []
  const agent = handoffAgent(handoffSession('session-nonote'))
  const { ctx, registered } = stubContext({
    meter,
    logs,
    compaction: { compactNow: (...args) => (folds.push(args), Promise.resolve({ shadowedSeqs: [1] })) },
  })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })

  // The mid-round reminder is queued for the next request; the model ends the
  // round without writing a note.
  await requestStep(registered, agent, 1)
  assert.equal(agent.injected.length, 1)
  await idleBoundary(registered, agent)
  assert.equal(folds.length, 0, 'handoff mode must not fold behind the model\'s back')
  assert.equal(agent.followed.length, 1, 'an unread reminder must wake the round instead of waiting for a human')
  assert.ok(agent.followed[0].content[0].text.includes(handoffPathFor(root, 'session-nonote', 1)))
  assert.ok(
    logs.some(([, message]) => String(message).includes('woke the round')),
    'the wake must be logged',
  )

  // A second idle event of the same round must not add a second wake.
  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 1)

  // The wake round starts: the wake message is this round's reminder, so the
  // waterfall must not stack a second copy in it.
  await requestStep(registered, agent, 2)
  assert.equal(agent.injected.length, 1, 'no duplicate reminder in the wake round')
  await requestStep(registered, agent, 2, 2)
  assert.equal(agent.injected.length, 1, 'and none on a later step of the same wake round')

  // Still no note: the budget allows one more wake, then it stops.
  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 2)
  await requestStep(registered, agent, 3)
  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 2, 'the reminder budget must cap the wakes')
  assert.equal(folds.length, 0)
  assert.ok(logs.some(([, message]) => String(message).includes('budget spent')))
})

test('a failed fold keeps the note and activates nothing', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const logs = []
  const agent = handoffAgent(handoffSession('session-fail'))
  const { ctx, registered } = stubContext({
    meter,
    logs,
    compaction: { compactNow: () => Promise.reject(new Error('engine busy')) },
  })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })
  const notePath = handoffPathFor(root, 'session-fail', 1)
  mkdirSync(join(root, 'session-fail'), { recursive: true })
  writeFileSync(notePath, `# note\n${'x'.repeat(400)}`, 'utf8')
  const tool = registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  assert.match(tool.execute({}, { agent }), /✓/)

  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 0, 'a fold that threw must not activate a turn')
  assert.ok(logs.some(([, message]) => String(message).includes('handoff fold failed')))
  const state = JSON.parse(readFileSync(join(root, 'session-fail', HANDOFF_STATE_FILE), 'utf8'))
  assert.equal(state.foldNo, 0, 'a failed fold does not count')
  assert.equal(state.ready.path, notePath, 'the note stays for the next attempt')
  assert.equal(state.pending, null)
})

test('an activation that cannot be sent survives a restart and is delivered once', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const logs = []
  const agent = handoffAgent(handoffSession('session-restart'))
  let refuses = true
  agent.followup = (message) => {
    if (refuses) throw new Error('agent gone')
    agent.followed.push(message)
  }
  const compaction = { compactNow: () => Promise.resolve({ shadowedSeqs: [1] }) }
  const first = stubContext({ meter, logs, compaction })
  apply(first.ctx, { foldMode: 'handoff', handoffDir: root })
  const notePath = handoffPathFor(root, 'session-restart', 1)
  mkdirSync(join(root, 'session-restart'), { recursive: true })
  writeFileSync(notePath, `# note\n${'x'.repeat(400)}`, 'utf8')
  first.registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME).execute({}, { agent })

  await idleBoundary(first.registered, agent)
  assert.equal(agent.followed.length, 0)
  assert.ok(logs.some(([, message]) => String(message).includes('could not activate the post-fold turn')))
  const afterFold = JSON.parse(readFileSync(join(root, 'session-restart', HANDOFF_STATE_FILE), 'utf8'))
  assert.equal(afterFold.foldNo, 1, 'the fold itself succeeded')
  assert.equal(afterFold.pending.deliveredAt, null)
  assert.equal(afterFold.pending.attempts, 1, 'the attempt is durable before it is sent')

  // A fresh apply() is what a restart looks like: nothing in memory survives.
  refuses = false
  const second = stubContext({ meter, compaction })
  apply(second.ctx, { foldMode: 'handoff', handoffDir: root })
  await idleBoundary(second.registered, agent)
  assert.equal(agent.followed.length, 1, 'the pending activation must be delivered after a restart')
  // The fold dropped the reading: no reminder wake may follow the activation.
  box.used = 100000
  await idleBoundary(second.registered, agent)
  assert.equal(agent.followed.length, 1, 'and only once')
})

test('the activation cap gives up instead of looping', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const logs = []
  const agent = handoffAgent(handoffSession('session-cap'))
  const dir = join(root, 'session-cap')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, HANDOFF_STATE_FILE),
    JSON.stringify({
      version: 1,
      sessionId: 'session-cap',
      foldNo: 1,
      pending: { path: join(dir, '001.handoff.md'), foldNo: 1, attempts: 2, deliveredAt: null },
    }),
    'utf8',
  )
  const { ctx, registered } = stubContext({ meter, logs, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })
  await idleBoundary(registered, agent)
  assert.equal(agent.followed.length, 0, 'the cap must stop the retry loop')
  // `logLine` hands the host a printf-style template, so the count lives in the
  // arguments, not in the message text.
  assert.ok(
    logs.some(([, message, , , attempts]) => String(message).includes('leaving the session to the human') && attempts === 2),
    'the give-up must be logged with the attempt count',
  )
})

test('a delegated session is never prepared, registered, or folded', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const folds = []
  const logs = []
  const agent = handoffAgent(handoffSession('session-child', { depth: 2 }))
  const { ctx, registered } = stubContext({
    meter,
    logs,
    compaction: { compactNow: (...args) => (folds.push(args), Promise.resolve({})) },
  })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })

  await requestStep(registered, agent, 1)
  assert.equal(agent.injected.length, 0, 'a delegate must not be reminded')
  const notePath = handoffPathFor(root, 'session-child', 1)
  mkdirSync(join(root, 'session-child'), { recursive: true })
  writeFileSync(notePath, `# note\n${'x'.repeat(400)}`, 'utf8')
  const tool = registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  assert.match(tool.execute({}, { agent }), /delegated session/)
  await idleBoundary(registered, agent)
  assert.equal(folds.length, 0)
  assert.equal(isDelegate(handoffSession('root', { depth: 0 })), false)
})

test('the activation target survives the prep that hands out the next note', async (t) => {
  const root = scratchRoot(t)
  const dir = join(root, 'session-gc')
  mkdirSync(dir, { recursive: true })
  // 现场复刻（2026-11-16 实机演练）：fold #1 的激活档 001.handoff.md 与更早的草稿同在一个
  // 目录里，准备轮为 fold #2 发提醒。旧实现把 001 一起回收 —— 实测激活 18:39:58.877，
  // 回收 18:40:03.431，激活轮第一条 read 18:40:04.983 得到 FS_NOT_FOUND。这里钉住：
  // 激活目标必须留下，只有更早的草稿被回收。
  writeFileSync(join(dir, '001.handoff.md'), 'activation target', 'utf8')
  writeFileSync(join(dir, '001.drill.md'), 'older draft', 'utf8')
  writeFileSync(
    join(dir, HANDOFF_STATE_FILE),
    JSON.stringify({
      version: 1,
      sessionId: 'session-gc',
      foldNo: 1,
      pending: { path: join(dir, '001.handoff.md'), foldNo: 1, attempts: 1, deliveredAt: 1 },
    }),
    'utf8',
  )
  const { box, meter } = movableMeter(600000)
  const agent = handoffAgent(handoffSession('session-gc'))
  const { ctx, registered } = stubContext({ meter, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })

  await requestStep(registered, agent, 1)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].content[0].text.includes(handoffPathFor(root, 'session-gc', 2)))
  assert.equal(existsSync(join(dir, '001.handoff.md')), true, 'the note the delivered activation points at is still there')
  assert.equal(existsSync(join(dir, '001.drill.md')), false, 'the older draft is recycled')
  assert.equal(
    handoffReapable(root, 'session-gc', [handoffPathFor(root, 'session-gc', 2), handoffPathFor(root, 'session-gc', 1)]).length,
    0,
    'recycling is idempotent',
  )
})

test('the note of the last fold is kept even when no activation record is left', async (t) => {
  const root = scratchRoot(t)
  const dir = join(root, 'session-gc')
  mkdirSync(dir, { recursive: true })
  // 不变量与持久化记录解耦：只要目录里还有 fold N 的档，准备轮 N+1 就不能删它 ——
  // 哪怕 pending 已经不在了（旧版状态文件、或将来清空 pending 的版本）。
  writeFileSync(join(dir, '001.handoff.md'), 'last fold', 'utf8')
  writeFileSync(join(dir, HANDOFF_STATE_FILE), JSON.stringify({ version: 1, sessionId: 'session-gc', foldNo: 1 }), 'utf8')
  const { box, meter } = movableMeter(600000)
  const agent = handoffAgent(handoffSession('session-gc'))
  const { ctx, registered } = stubContext({ meter, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })

  await requestStep(registered, agent, 1)
  assert.equal(existsSync(join(dir, '001.handoff.md')), true, 'the newest note is not recyclable while it is still the activation target')
})

test('the note of an older fold is recycled once a newer fold exists', async (t) => {
  const root = scratchRoot(t)
  const dir = join(root, 'session-gc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '001.handoff.md'), 'fold 1', 'utf8')
  writeFileSync(join(dir, '002.handoff.md'), 'fold 2', 'utf8')
  writeFileSync(
    join(dir, HANDOFF_STATE_FILE),
    JSON.stringify({ version: 1, sessionId: 'session-gc', foldNo: 2, pending: { path: join(dir, '002.handoff.md'), foldNo: 2, attempts: 1, deliveredAt: 1 } }),
    'utf8',
  )
  const { box, meter } = movableMeter(600000)
  const agent = handoffAgent(handoffSession('session-gc'))
  const { ctx, registered } = stubContext({ meter, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })

  await requestStep(registered, agent, 1)
  assert.deepEqual(readdirSync(dir).sort(), [HANDOFF_STATE_FILE, '002.handoff.md'].sort(), 'only the previous fold is kept')
})

test('the backstop sweep recycles notes older than a week but never a pending one', (t) => {
  const root = scratchRoot(t)
  const dir = join(root, 'session-old')
  mkdirSync(dir, { recursive: true })
  const stale = join(dir, '001.handoff.md')
  const fresh = join(dir, '002.handoff.md')
  writeFileSync(stale, 'x'.repeat(300), 'utf8')
  writeFileSync(fresh, 'y'.repeat(300), 'utf8')
  const old = new Date(Date.now() - HANDOFF_MAX_AGE_MS - 86400000)
  utimesSync(stale, old, old)

  const writeState = (pending) =>
    writeFileSync(join(dir, HANDOFF_STATE_FILE), JSON.stringify({ version: 1, sessionId: 'session-old', foldNo: 1, pending }), 'utf8')

  // A queued activation still points at the stale note: it must survive.
  writeState({ path: stale, foldNo: 1, attempts: 0, deliveredAt: null })
  assert.equal(sweepHandoffs(root, Date.now(), HANDOFF_MAX_AGE_MS), 0)
  assert.equal(existsSync(stale), true)

  // Delivered: the stale note is fair game, the fresh one is not.
  writeState({ path: stale, foldNo: 1, attempts: 1, deliveredAt: Date.now() })
  assert.equal(sweepHandoffs(root, Date.now(), HANDOFF_MAX_AGE_MS), 1)
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(fresh), true)

  // A directory is only pruned when nothing in it — notes or state — has been
  // touched for the same week: pruning takes the state file with it, and that file
  // is where a pending activation lives. A unit test caught the hard version of
  // this by losing its own fixture at load.
  unlinkSync(fresh)
  assert.equal(sweepHandoffs(root, Date.now(), HANDOFF_MAX_AGE_MS), 0)
  assert.equal(existsSync(dir), true, 'a fresh state file keeps its directory alive')
  const staleState = new Date(Date.now() - HANDOFF_MAX_AGE_MS - 86400000)
  utimesSync(join(dir, HANDOFF_STATE_FILE), staleState, staleState)
  assert.equal(sweepHandoffs(root, Date.now(), HANDOFF_MAX_AGE_MS), 0)
  assert.equal(existsSync(dir), false, 'a directory nobody has touched for the sweep window goes away')
})

test('handoff_ready refuses everything it cannot honour', async (t) => {
  const root = scratchRoot(t)
  const agent = handoffAgent(handoffSession('session-refuse'))
  const toolFor = (config) => {
    const { ctx, registered } = stubContext({ used: 600000, compaction: { compactNow: () => Promise.resolve({}) } })
    apply(ctx, { handoffDir: root, ...config })
    return registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  }

  // Outside handoff mode the tool is not registered at all, so the catalog only
  // carries what the current mode can honour.
  assert.equal(toolFor({}), undefined, 'off must not advertise handoff_ready')
  assert.equal(toolFor({ foldMode: 'idle' }), undefined, 'idle must not advertise handoff_ready')

  // Defense in depth: a call already in flight when the mode flips must refuse
  // rather than register against a mode that no longer wants a handoff.
  const live = { foldMode: 'handoff', handoffDir: root }
  const liveCtx = stubContext({ used: 600000, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(liveCtx.ctx, live)
  const inFlight = liveCtx.registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  live.foldMode = 'off'
  assert.match(inFlight.execute({}, { agent }), /only applies in handoff fold mode/)
  live.foldMode = 'handoff'

  const tool = toolFor({ foldMode: 'handoff' })
  const notePath = handoffPathFor(root, 'session-refuse', 1)
  assert.match(tool.execute({}, { agent }), /there is no handoff note at/)
  assert.match(tool.execute({ path: join(root, 'elsewhere', 'note.md') }, { agent }), /not the one this session owns/)

  mkdirSync(join(root, 'session-refuse'), { recursive: true })
  writeFileSync(notePath, 'too short', 'utf8')
  assert.match(tool.execute({}, { agent }), new RegExp(`only ${'too short'.length} characters`))
  assert.equal(handoffFileChars(notePath), 'too short'.length)
  assert.equal(handoffFileChars(join(root, 'missing.md')), null)

  // The one accepted shape registers the note and says what happens next.
  writeFileSync(notePath, `# note\n${'x'.repeat(HANDOFF_MIN_CHARS)}`, 'utf8')
  const ok = tool.execute({}, { agent })
  assert.match(ok, /✓ handoff registered/)
  assert.match(ok, /End this round now/)
  const state = JSON.parse(readFileSync(join(root, 'session-refuse', HANDOFF_STATE_FILE), 'utf8'))
  assert.equal(state.ready.path, notePath)
  assert.ok(state.ready.chars >= HANDOFF_MIN_CHARS)
  // Registering twice is not a way to queue two folds.
  assert.match(tool.execute({}, { agent }), /already queued|✓/)
})

test('a note registered early waits, and a reading that collapsed releases it', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const folds = []
  const logs = []
  const agent = handoffAgent(handoffSession('session-early'))
  const { ctx, registered } = stubContext({
    meter,
    logs,
    compaction: { compactNow: (...args) => (folds.push(args), Promise.resolve({})) },
  })
  apply(ctx, { foldMode: 'handoff', handoffDir: root })
  const notePath = handoffPathFor(root, 'session-early', 1)
  mkdirSync(join(root, 'session-early'), { recursive: true })
  writeFileSync(notePath, `# note\n${'x'.repeat(400)}`, 'utf8')
  const tool = registered.tools.find((definition) => definition.name === HANDOFF_TOOL_NAME)
  assert.match(tool.execute({}, { agent }), /✓/)

  // A reading that is merely below the prep point keeps the note for the next end.
  box.used = 500000
  await idleBoundary(registered, agent)
  assert.equal(folds.length, 0)
  assert.ok(logs.some(([, message]) => String(message).includes('below the prep point')))

  // A reading far below it means somebody else folded: the note was not used.
  box.used = 200000
  await idleBoundary(registered, agent)
  assert.equal(folds.length, 0)
  assert.ok(logs.some(([, message]) => String(message).includes('folded by something else')))
  const state = JSON.parse(readFileSync(join(root, 'session-early', HANDOFF_STATE_FILE), 'utf8'))
  assert.equal(state.ready, null, 'the unused note is released, and the next cycle re-preps')
  assert.equal(state.foldNo, 0)
})

test('prep reminders are one per turn and capped per cycle', async (t) => {
  const root = scratchRoot(t)
  const { box, meter } = movableMeter(600000)
  const logs = []
  const agent = handoffAgent(handoffSession('session-budget'))
  const { ctx, registered } = stubContext({ meter, logs, compaction: { compactNow: () => Promise.resolve({}) } })
  apply(ctx, { foldMode: 'handoff', handoffDir: root, handoffReminders: 2 })

  await requestStep(registered, agent, 1, 1)
  await requestStep(registered, agent, 1, 2)
  assert.equal(agent.injected.length, 1, 'one per turn')
  await requestStep(registered, agent, 2, 1)
  assert.equal(agent.injected.length, 2, 'a new turn gets one more')
  await requestStep(registered, agent, 3, 1)
  assert.equal(agent.injected.length, 2, 'the budget stops the nagging')
  assert.ok(logs.some(([, message]) => String(message).includes('reminder budget spent')))
})
