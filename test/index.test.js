import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals, name, inject, CONTEXT_NAME, VARIABLE_NAME } from '../lib/index.js'

const { resolveOptions, readOccupancy, settleBand, quantize, quantizeHeadroom, headroomDisplayStep, render, patchCompactionInstruction, patchCompactionRequest, isCompactionRequest, isTaggedCompactionRequest, messageText, DEFAULT_OPTIONS, DEFAULT_COMPACTION_RULES } = internals

/** A 1M window reserving the DeepSeek adapter's default 256K completion tokens. */
const WINDOW = 1000000
const MAX_TOKENS = 256000
/** min(0.8 * 1M, 1M - 256K - 64K) — the compaction point this deployment runs at. */
const THRESHOLD = 678464

/** Minimal ctx capturing what the plugin registers. */
function stubContext({ used, meter, projections } = {}) {
  const registered = { variable: undefined, context: undefined, listeners: {} }
  const tokenMeter = meter === undefined ? { measure: () => ({ totalTokens: used }) } : meter
  const ctx = {
    logger: undefined,
    get: (key) => {
      if (key === 'tokenMeter') return tokenMeter
      if (key === 'sessionProjections') return projections
      return undefined
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
  assert.deepEqual(inject, ['systemPrompt'])
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
  assert.equal(quantizeHeadroom(THRESHOLD - 610000, WINDOW, options), 65000)
})

test('the tight band drops the calm language and names the small headroom', () => {
  const { ctx, registered } = stubContext({ used: 610000 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /Headroom is genuinely small/)
  assert.doesNotMatch(line, /Context is NOT scarce/)
  assert.match(line, /About 65K tokens of headroom remain/)
})

test('over the compaction point the line stops promising headroom', () => {
  const { ctx, registered } = stubContext({ used: 700000 })
  apply(ctx, {})
  const line = lineFor(registered, stubSession())
  assert.match(line, /At or past the automatic compaction point/)
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

test('disabled mounts nothing at all', () => {
  const { ctx, registered } = stubContext({ used: 1000 })
  apply(ctx, { enabled: false, patchCompactionPrompt: false })
  assert.equal(registered.variable, undefined)
  assert.equal(registered.context, undefined)
  assert.equal(registered.listeners['llm/stream'], undefined)
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
  assert.equal(registered.listeners['llm/stream'], undefined)
  assert.ok(registered.variable, 'the measured line stays installed')
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

test('a floored headroom names its own step instead of claiming less than 1K', () => {
  const options = resolveOptions({})
  // 2464 floors to one full step; only a reading inside the step floors to zero.
  assert.equal(headroomDisplayStep(2464, WINDOW, options), 2000)
  assert.equal(quantizeHeadroom(2464, WINDOW, options), 2000)
  assert.equal(quantizeHeadroom(1500, WINDOW, options), 0)
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
      headroomRaw: 1500,
      headroomStep: 2000,
    },
    options,
  )
  assert.match(rendered, /Under 2K tokens of headroom remain before it\./)
  assert.doesNotMatch(rendered, /less than 1K/)
})

test('the first rule forbids quoting a budget claim and embeds none itself', () => {
  const rule = DEFAULT_COMPACTION_RULES[0]
  assert.match(rule, /not even quoted, paraphrased, or listed as an example/)
  assert.match(rule, /earlier checkpoint already carries one/)
  assert.equal(rule.includes('"'), false, 'the rule must not hand the model a quotable false claim')
  assert.match(DEFAULT_COMPACTION_RULES[1], /whose only justification was context pressure/)
})
