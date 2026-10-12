import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals, name, inject, Config, CONTEXT_NAME, VARIABLE_NAME } from '../lib/index.js'

const { resolveOptions, readOccupancy, settleBand, quantize, quantizeHeadroom, headroomDisplayStep, render, patchCompactionInstruction, patchCompactionRequest, isCompactionRequest, isTaggedCompactionRequest, messageText, DEFAULT_OPTIONS, DEFAULT_COMPACTION_RULES, PACE_LADDER, median, nextPaceState, samplePace, paceSteps, paceRung, settlePace, paceSentence, tightClause, foldClause, shouldFoldAtIdle, backendIdentity } = internals

/** A 1M window reserving the DeepSeek adapter's default 256K completion tokens. */
const WINDOW = 1000000
const MAX_TOKENS = 256000
/** min(0.8 * 1M, 1M - 256K - 64K) — the compaction point this deployment runs at. */
const THRESHOLD = 678464

/** Minimal ctx capturing what the plugin registers. */
function stubContext({ used, meter, projections, compaction, commands, logs } = {}) {
  const registered = { variable: undefined, context: undefined, listeners: {}, injections: [] }
  const tokenMeter = meter === undefined ? { measure: () => ({ totalTokens: used }) } : meter
  const services = { tokenMeter, compaction, sessionProjections: projections, commands }
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
    on: (event, listener) => {
      registered.listeners[event] = listener
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

  // Off by default: the listener exists (so the switch is live) but never folds.
  const off = stubContext({ used: 640000, compaction })
  apply(off.ctx, {})
  assert.equal(typeof off.registered.listeners['agent/status'], 'function')
  off.registered.listeners['agent/status']({ agent: { session }, status: 'idle' })
  await tick()
  assert.equal(calls.length, 1, 'the default configuration must not fold anything')

  // The pure decision, including the band where the fold must not fire.
  const options = resolveOptions({ foldAtIdle: true })
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, options).fold, true)
  assert.equal(shouldFoldAtIdle({ used: 620000, threshold: THRESHOLD, window: WINDOW }, options).fold, false)
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: undefined, window: WINDOW }, options).fold, false)
  assert.equal(shouldFoldAtIdle({ used: 640000, threshold: THRESHOLD, window: WINDOW }, resolveOptions({})).fold, false)
  assert.equal(DEFAULT_OPTIONS.foldAtIdle, false, 'the fold is a policy decision, so it ships off')
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
