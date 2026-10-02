/**
 * dsh-context-truth — the model's only authority on its own context pressure.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in the harness ever tells the model how full its context is, so the
 * model guesses from the conversation's length. On a long session it guesses
 * "context is nearly exhausted", stops doing write work, and hands off to a
 * subagent — while the host's own meter reads 17% of a 1M window. Worse, the
 * claim lands in the transcript, the next compaction folds it into a summary as
 * "established background", and the false belief survives every later
 * compaction. The model never gets a correction because no correction exists.
 *
 * TWO CAPABILITIES, ONE BELIEF TO KILL
 * ------------------------------------
 * 1. MEASUREMENT IN (default on). One dynamic runtime-context line, refreshed
 *    from the host's own token meter, re-injected only when the reading moves a
 *    display step. It adds no tool, no message, and no per-step noise — one
 *    stable paragraph that changes about a dozen times per compaction cycle.
 * 2. CLAIM FILTERING (default on). The compaction summarizer is told not to
 *    record the assistant's own guesses about its remaining budget, so the
 *    false belief stops being re-injected as established background.
 *
 * HOW IT PLUGS IN
 * ---------------
 * `systemPrompt.variable()` is evaluated on every prompt assembly with the
 * agent in hand (the same seam the harness uses for `{{model}}` / `{{cwd}}`),
 * and `systemPrompt.context()` contributes the rendered text to the dynamic
 * runtime-context snapshot. The agent loop commits a new "Current runtime
 * context" message only when that rendered snapshot differs byte-for-byte from
 * the retained one, which is why the reading is quantized: identical text costs
 * nothing, drifted text appends.
 *
 * The summarizer directive is the final user message of the `purpose:
 * 'compaction'` call. That call is not an agent-loop request (the loop's own
 * requests are frozen and log-verified), so its tail can be extended through
 * the public `llm/stream` waterfall. Only the tail changes: the replayed
 * conversation prefix — the part the provider caches — stays byte-identical.
 *
 * The call is identified by that `purpose` tag whenever the caller sets one; the
 * directive-text fallback demands that the trailing message *begin* with the
 * directive, so a tool result that merely quotes the engine — a source dump, a
 * log excerpt, a grep hit — is never mistaken for a call. Getting that wrong is
 * not harmless: a look-alike request would be patched too, and it would also
 * consume the one-shot warning, leaving a later real failure silent.
 *
 * WHAT IT MEASURES
 * ----------------
 * Primary: `tokenMeter.measure(session).totalTokens` — the host's price for the
 * next request, and the exact number automatic compaction compares against.
 * Fallback: the `contextPressure` projection (provider-reported prompt usage),
 * which is the same figure the Web UI's context ring renders. The auto-compaction
 * point is derived the way `dsh-compaction-basic` derives it:
 * `min(window * thresholdRatio, window - reservedCompletion - headroom)`.
 *
 * NO IMPORTS, NO BUILD: this file is dependency-free ESM on purpose, so the
 * plugin installs into any profile without a node_modules copy or a toolchain.
 * It is both the source and the runtime artifact (`lib/index.js`).
 */

/** Stable cordis plugin name (loader diagnostics, and the runtime-context section name). */
export const name = 'context-truth'

/** Prompt context name; must be unique per layer. */
export const CONTEXT_NAME = 'context-truth'

/** Prompt variable carrying the rendered line. */
export const VARIABLE_NAME = 'context_occupancy'

/** Service required before the contribution can register. */
export const inject = ['systemPrompt']

/** Orders the line first inside the runtime-context block (sandbox is 110, approval 115). */
const DEFAULT_ORDER = 100

/** Substring that identifies the compaction engine's directive wherever `purpose` is absent. */
const COMPACTION_INSTRUCTION_MARKER = 'acting as a compaction engine'

/**
 * Opening words of that directive. The fallback test requires the trailing
 * message to start here, which is what separates "this message IS the directive"
 * from "this message happens to quote it".
 */
const COMPACTION_INSTRUCTION_HEAD = 'You are now acting as a compaction engine'

/** Default rules appended to the compaction directive. Keep the first one first: it is the idempotence marker. */
const DEFAULT_COMPACTION_RULES = [
  "- Never record the assistant's own statements about its remaining context, token budget, or context-window pressure — not even quoted, paraphrased, or listed as an example, and not when an earlier checkpoint already carries one: drop that wording instead of copying it forward. Those readings are measured by the host and delivered separately; a model's guess about them is not a durable fact.",
  '- Never record a plan to stop, defer, or hand off work whose only justification was context pressure. Record the actual task state instead.',
]

const DEFAULT_OPTIONS = {
  /** Master switch for the measured line; `false` mounts no context contribution. */
  enabled: true,
  /** Where the line sits among runtime-context contributions. */
  order: DEFAULT_ORDER,
  /** Text language: 'en' | 'zh'. */
  language: 'en',
  /** Emit the auto-compaction point and the headroom left before it. */
  showAutoCompactionPoint: true,
  /**
   * Mirror of `dsh-compaction-basic`'s policy. Keep these equal to the profile's
   * compaction config; the line only reports the point, it never enforces it.
   */
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  /** Reserved completion tokens; `null` reads the routed request's own maxTokens. */
  reservedCompletionTokens: null,
  /** Band edges as a fraction of the auto-compaction point. */
  moderateAt: 0.5,
  tightAt: 0.85,
  /** Fraction of the compaction point a reading must fall back below to leave a band. */
  hysteresis: 0.05,
  /**
   * Display quantum as a percentage of the window. The rendered text changes
   * only when the reading crosses a quantum, which is what keeps re-injection
   * (and therefore cache churn) rare. 0 disables quantization — do not: the
   * snapshot would then be re-committed on every single step.
   */
  quantumPercent: 5,
  /** Append the "this line is the only authority" clause. */
  authoritative: true,
  /** Add the explicit "earlier claims are stale" clause to the calm band. */
  staleClaimClause: true,
  /** Log each band change through ctx.logger, when a logger is present. */
  logBandChanges: true,
  /** Append `compactionRules` to the summarizer directive. */
  patchCompactionPrompt: true,
  /** Rules appended to the summarizer directive; `[]` disables the append. */
  compactionRules: DEFAULT_COMPACTION_RULES,
}

/** Clamp a numeric option, falling back when it is not a finite number. */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Merge user config over the defaults with light validation. */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULT_OPTIONS, ...raw }
  const rules = Array.isArray(merged.compactionRules)
    ? merged.compactionRules.filter((rule) => typeof rule === 'string' && rule.trim().length > 0)
    : DEFAULT_COMPACTION_RULES
  return {
    ...merged,
    order: num(merged.order, DEFAULT_ORDER),
    language: merged.language === 'zh' ? 'zh' : 'en',
    thresholdRatio: num(merged.thresholdRatio, DEFAULT_OPTIONS.thresholdRatio),
    headroomTokens: Math.max(0, num(merged.headroomTokens, DEFAULT_OPTIONS.headroomTokens)),
    reservedCompletionTokens:
      merged.reservedCompletionTokens === null || merged.reservedCompletionTokens === undefined
        ? null
        : Math.max(0, num(merged.reservedCompletionTokens, 0)),
    moderateAt: num(merged.moderateAt, DEFAULT_OPTIONS.moderateAt),
    tightAt: num(merged.tightAt, DEFAULT_OPTIONS.tightAt),
    hysteresis: Math.max(0, num(merged.hysteresis, DEFAULT_OPTIONS.hysteresis)),
    quantumPercent: Math.max(0, num(merged.quantumPercent, DEFAULT_OPTIONS.quantumPercent)),
    compactionRules: rules,
  }
}

/** Compact token count: 172437 -> "172K", 1000000 -> "1.00M". */
function formatTokens(value) {
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`
  return String(Math.round(value))
}

/** Percentage of `total`, rounded to a whole number. */
function percentOf(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null
  return Math.round((value / total) * 100)
}

/** Resolve a service that may or may not be mounted, without ever throwing. */
function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/**
 * Read the host's own occupancy figure for one session.
 * @returns `{ used, window, reserved, threshold }`; any field may be `undefined`.
 */
function readOccupancy(ctx, session, options) {
  const result = {}
  let used
  let window_

  const meter = safeGet(ctx, 'tokenMeter')
  if (meter !== undefined && typeof meter.measure === 'function') {
    try {
      const measured = meter.measure(session)
      if (measured !== undefined && Number.isFinite(measured.totalTokens)) used = measured.totalTokens
    } catch {
      used = undefined // a broken meter replay is the meter's business, not the model's
    }
  }

  try {
    const context = typeof session.requestContext === 'function' ? session.requestContext() : undefined
    if (context !== undefined && context !== null && Number.isFinite(context.contextWindow)) {
      window_ = context.contextWindow
    }
  } catch {
    window_ = undefined
  }

  if (used === undefined || window_ === undefined) {
    const projections = safeGet(ctx, 'sessionProjections')
    if (projections !== undefined && typeof projections.stateOf === 'function') {
      try {
        const state = projections.stateOf(session, 'contextPressure')
        if (state !== null && typeof state === 'object') {
          if (used === undefined && Number.isFinite(state.pressureTokens)) {
            used = Math.max(
              0,
              state.pressureTokens +
                (Number.isFinite(state.surfaceTokens) ? state.surfaceTokens : 0) -
                (Number.isFinite(state.sampledSurfaceTokens) ? state.sampledSurfaceTokens : 0),
            )
          }
          if (window_ === undefined && Number.isFinite(state.contextWindow)) window_ = state.contextWindow
        }
      } catch {
        // keep whatever was already resolved
      }
    }
  }

  result.used = used
  result.window = window_

  let reserved = options.reservedCompletionTokens
  if (reserved === null) {
    try {
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const declared = header?.config?.maxTokens
      reserved = Number.isFinite(declared) ? declared : 0
    } catch {
      reserved = 0
    }
  }
  result.reserved = reserved

  if (options.showAutoCompactionPoint && Number.isFinite(window_)) {
    const budget = window_ - reserved - options.headroomTokens
    const threshold = Math.floor(Math.min(window_ * options.thresholdRatio, budget))
    if (threshold > 0 && threshold < window_) result.threshold = threshold
  }

  return result
}

/** Bands from calmest to most urgent. */
const BANDS = ['ample', 'moderate', 'tight', 'critical']

/** Lower edge of a band, as a fraction of the auto-compaction point. */
function bandFloor(band, options) {
  switch (band) {
    case 'moderate':
      return options.moderateAt
    case 'tight':
      return options.tightAt
    case 'critical':
      return 1
    default:
      return 0
  }
}

/** Raw band for a reading, before hysteresis. */
function rawBand(ratio, options) {
  if (ratio >= 1) return 'critical'
  if (ratio >= options.tightAt) return 'tight'
  if (ratio >= options.moderateAt) return 'moderate'
  return 'ample'
}

/**
 * Apply hysteresis so a reading hovering on an edge does not flip the published
 * text back and forth (each flip would append a runtime-context message).
 */
function settleBand(ratio, previous, options) {
  const raw = rawBand(ratio, options)
  if (previous === undefined) return raw
  // Rising urgency is immediate: the model must hear about pressure at once.
  if (BANDS.indexOf(raw) >= BANDS.indexOf(previous)) return raw
  // Calm returns only once the reading falls clear of the previous band's floor.
  return ratio <= bandFloor(previous, options) - options.hysteresis ? raw : previous
}

/** The display step for one window, in tokens. */
function displayStep(window_, options) {
  return options.quantumPercent > 0 && Number.isFinite(window_) && window_ > 0
    ? Math.max(1000, Math.round((options.quantumPercent / 100) * window_))
    : 1
}

/** Quantize a reading DOWN so identical states render byte-identical text. */
function quantize(used, window_, options) {
  if (!Number.isFinite(used)) return undefined
  const step = displayStep(window_, options)
  return Math.floor(used / step) * step
}

/**
 * Display step for the remaining-headroom figure. Every step is a function of the
 * reading, so a whole bucket renders to one identical string.
 */
function headroomDisplayStep(headroom, window_, options) {
  const coarse = displayStep(window_, options)
  const tiers = [
    coarse,
    Math.max(1000, Math.round(coarse * 0.4)),
    Math.max(1000, Math.round(coarse * 0.1)),
    2000,
  ]
  for (const tier of tiers) {
    if (headroom >= 4 * tier) return tier
  }
  return tiers[tiers.length - 1]
}

/**
 * Quantize the remaining headroom DOWN on a step that tightens as the room runs
 * out. Two rules meet here: the reading must never promise more room than the
 * session has (so it always rounds down), and it must stay useful to within a
 * few thousand tokens once compaction is close (so the step shrinks near zero).
 */
function quantizeHeadroom(headroom, window_, options) {
  if (!Number.isFinite(headroom) || headroom < 0) return undefined
  const step = headroomDisplayStep(headroom, window_, options)
  return Math.floor(headroom / step) * step
}

/** The clause that closes every variant. */
function authorityClause(language) {
  return language === 'zh'
    ? '本行由宿主实测，是上下文压力的唯一权威——不要凭对话长度或轮数自行估计。'
    : "This host-measured line is the only authority on context pressure; never estimate it from the conversation's length."
}

/** The clause that retires claims inherited from earlier turns and checkpoints. */
function staleClause(language) {
  return language === 'zh'
    ? '此前任何"上下文快满了"的说法（含压缩检查点里的）都已作废。'
    : 'Earlier claims that context is nearly exhausted — including ones inside compacted checkpoints — are stale.'
}

/** "under 50K" / "不足 50K" — the honest form of a figure below one display step. */
function underStep(step, zh) {
  return zh ? `不足 ${formatTokens(step)}` : `under ${formatTokens(step)}`
}

/** "under 5" / "不足 5" — the same honesty for a percentage the caller suffixes with `%`. */
function underPercent(step, window_, zh) {
  const value = Math.max(1, Math.round(percentOf(step, window_) ?? 1))
  return zh ? `不足 ${value}` : `under ${value}`
}

/** Render the reading for one band. Pure: same inputs, same bytes. */
function render(band, reading, options) {
  const zh = options.language === 'zh'
  const parts = []
  if (options.authoritative) parts.push(authorityClause(options.language))
  if (band === 'ample' && options.staleClaimClause) parts.push(staleClause(options.language))
  const tail = parts.length === 0 ? '' : ` ${parts.join(' ')}`

  if (band === 'unknown') {
    return zh
      ? `上下文实况：本会话尚未取到用量读数。不要据此声称上下文紧张。${tail}`
      : `Context occupancy: no reading yet in this session. Do not claim context is scarce on that basis.${tail}`
  }

  // A figure that rounds below one display step says so instead of rendering "0".
  // A floored zero used to contradict the headroom on the same line — the reading
  // was 30–50K against a 50K step — and read as an empty window.
  const step = Number.isFinite(reading.step) && reading.step > 0 ? reading.step : undefined
  const flooredUsed = reading.quantized === 0 && Number.isFinite(reading.used) && reading.used > 0
  const used = flooredUsed && step !== undefined ? underStep(step, zh) : formatTokens(reading.quantized)
  const window_ = formatTokens(reading.window)
  const percent =
    flooredUsed && step !== undefined ? underPercent(step, reading.window, zh) : `${reading.percent}`
  const head = reading.headroom
  const headStep =
    Number.isFinite(reading.headroomStep) && reading.headroomStep > 0 ? reading.headroomStep : undefined
  const flooredHead = head === 0 && Number.isFinite(reading.headroomRaw) && reading.headroomRaw > 0
  const point = Number.isFinite(reading.threshold)
    ? zh
      ? ` 自动压缩阈值 ${formatTokens(reading.threshold)}（窗口的 ${percentOf(reading.threshold, reading.window)}%）。`
      : ` Automatic compaction fires at ${formatTokens(reading.threshold)} (${percentOf(reading.threshold, reading.window)}% of the window).`
    : ''
  const remaining =
    head === undefined
      ? ''
      : flooredHead && headStep !== undefined
        ? zh
          ? ` 距阈值不足 ${formatTokens(headStep)} tokens。`
          : ` Under ${formatTokens(headStep)} tokens of headroom remain before it.`
        : zh
          ? ` 距阈值还有约 ${formatTokens(head)} tokens。`
          : ` About ${formatTokens(head)} tokens of headroom remain before it.`
  const head0 = zh
    ? `上下文实况（宿主实测）：已用 ${used} / ${window_}（${percent}%）。`
    : `Context occupancy (host-measured): ${used} / ${window_} tokens used (${percent}%).`

  switch (band) {
    case 'ample':
      return zh
        ? `${head0}${point}${remaining} 上下文不紧张——不要因为"上下文不够"而收尾、交接子代理或缩小范围。${tail}`
        : `${head0}${point}${remaining} Context is NOT scarce — do not wrap up, hand off to a subagent, or narrow scope for context reasons.${tail}`
    case 'moderate':
      return zh
        ? `${head0}${point}${remaining} 仍有充足余量，继续推进即可，顺手把关键状态写进文档或提交。${tail}`
        : `${head0}${point}${remaining} There is still real headroom — keep going, and keep durable notes or commits current as you work.${tail}`
    case 'tight':
      return zh
        ? `${head0}${point}${remaining} 余量确实不多了——收完当前这一步、把状态落到磁盘，再考虑交接。${tail}`
        : `${head0}${point}${remaining} Headroom is genuinely small — finish the current step, land durable state, then hand off.${tail}`
    default:
      return zh
        ? `${head0}${point} 已到或越过自动压缩点——接下来可能发生压缩折叠，别让关键状态只存在于本窗口。${tail}`
        : `${head0}${point} At or past the automatic compaction point — expect earlier turns to be folded; keep nothing critical only in this window.${tail}`
  }
}

/** The line used before any measurement exists (and whenever one cannot be taken). */
function renderUnknown(options) {
  return render('unknown', {}, options)
}

/** Concatenate the text blocks of one LLM message, or `undefined` when it has none. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Extend one compaction directive with the extra rules.
 * @param text - the directive's full text.
 * @param rules - rules to append; an empty list patches nothing.
 * @returns the extended text, or `undefined` when no patch is due.
 */
function patchCompactionInstruction(text, rules) {
  if (typeof text !== 'string' || !text.includes(COMPACTION_INSTRUCTION_MARKER)) return undefined
  if (rules.length === 0) return undefined
  if (text.includes(rules[0])) return undefined // already patched: stay idempotent
  return `${text}\n${rules.join('\n')}`
}

/**
 * Test whether one LLM request is the compaction summarization call.
 *
 * A tag set by the caller is authoritative and is never second-guessed. Without
 * one, the trailing message must *be* the directive: a message that merely
 * contains the marker somewhere — a tool result dumping the engine source or a
 * session log is the common case — is an ordinary request.
 *
 * @param options - request envelope observed at the `llm/stream` waterfall.
 * @returns whether the request carries the compaction directive.
 */
function isCompactionRequest(options) {
  if (options === null || typeof options !== 'object') return false
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  if (options.purpose !== undefined) return options.purpose === 'compaction'
  const text = messageText(messages[messages.length - 1])
  return typeof text === 'string' && text.trimStart().startsWith(COMPACTION_INSTRUCTION_HEAD)
}

/**
 * Whether the request identifies itself as the engine's call. Used only to decide
 * who may spend the one-shot warning: a heuristic match must never be able to
 * silence a later, real failure.
 */
function isTaggedCompactionRequest(options) {
  return options !== null && typeof options === 'object' && options.purpose === 'compaction'
}

/**
 * Patch one compaction request in place by replacing its trailing directive.
 * @param options - request envelope observed at the `llm/stream` waterfall.
 * @param rules - rules to append.
 * @returns whether the request now carries the rules.
 */
function patchCompactionRequest(options, rules) {
  if (!isCompactionRequest(options)) return false
  const messages = options.messages
  const last = messages[messages.length - 1]
  const text = messageText(last)
  const patched = patchCompactionInstruction(text, rules)
  if (patched === undefined) return text !== undefined && rules.length > 0 && text.includes(rules[0])
  try {
    options.messages = [...messages.slice(0, -1), { ...last, content: [{ type: 'text', text: patched }] }]
  } catch {
    return false
  }
  const applied = messageText(options.messages[options.messages.length - 1])
  return applied !== undefined && applied.includes(rules[0])
}

/**
 * Mount both contributions for the lifetime of `ctx`.
 *
 * Mounting twice in one scope is a supported outcome, not a crash: a deployment
 * that both lists the package as a bundle and injects it at runtime mounts two
 * instances of the same layer, and the second one cannot own the same prompt
 * context and variable. The first instance keeps serving and the second stays
 * inert, so the duplicate never turns into a failed plugin row.
 *
 * @param ctx - plugin context; registrations and listeners are disposed with it.
 * @param config - optional overrides of the defaults documented above.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)

  if (options.enabled) {
    try {
      installContextLine(ctx, options)
    } catch (error) {
      if (isAlreadyRegistered(error)) {
        const logger = ctx.logger
        if (logger !== undefined && typeof logger.info === 'function') {
          logger.info('context-truth: another instance already owns the context line in this scope; staying inert')
        }
        return
      }
      throw error
    }
  }

  installCompactionPatch(ctx, options)
}

/** Whether a registration failed because the name is already taken in this layer. */
function isAlreadyRegistered(error) {
  return error instanceof Error && error.message.includes('already registered')
}

/** Install the `llm/stream` listener that extends the summarizer directive. */
function installCompactionPatch(ctx, options) {
  if (!options.patchCompactionPrompt || options.compactionRules.length === 0) return
  let warned = false
  ctx.on('llm/stream', (request, next) => {
    try {
      const applied = patchCompactionRequest(request, options.compactionRules)
      // Only a request its own caller tagged as compaction may spend the one-shot
      // warning. Warning on a heuristic match let an ordinary turn — one whose
      // trailing tool result quoted the directive — burn the warning, and a real
      // failure after that would have been completely silent.
      if (!applied && isTaggedCompactionRequest(request) && !warned) {
        warned = true
        const logger = ctx.logger
        if (logger !== undefined && typeof logger.warn === 'function') {
          logger.warn('context-truth: could not extend the compaction directive (request envelope is immutable in this deployment)')
        }
      }
    } catch {
      // Interception must never break a model call.
    }
    return next()
  })
}

/** Install the dynamic runtime-context line. */
function installContextLine(ctx, options) {
  /** Last band published per session (hysteresis memory); never rendered. */
  const bands = new WeakMap()
  /** Last text handed out, so a failed read degrades to the previous line. */
  let lastText = renderUnknown(options)

  const line = (assembly) => {
    try {
      const session = assembly?.agent?.session
      if (session === undefined || session === null) return lastText

      const reading = readOccupancy(ctx, session, options)
      const window_ = reading.window
      const ratio =
        Number.isFinite(reading.used) && Number.isFinite(window_) && window_ > 0
          ? reading.used / window_
          : undefined

      let band
      if (ratio === undefined) band = 'unknown'
      else if (Number.isFinite(reading.threshold) && reading.threshold > 0) {
        band = settleBand(reading.used / reading.threshold, bands.get(session), options)
      } else {
        band = settleBand(ratio, bands.get(session), options)
      }

      if (band !== bands.get(session)) {
        const previous = bands.get(session)
        bands.set(session, band)
        if (options.logBandChanges && band !== 'unknown') {
          const logger = ctx.logger
          if (logger !== undefined && typeof logger.info === 'function') {
            logger.info(
              'context-truth: %s -> %s (used=%s window=%s compactionAt=%s)',
              previous ?? 'none',
              band,
              reading.used,
              window_,
              reading.threshold,
            )
          }
        }
      }

      const quantized = band === 'unknown' ? undefined : quantize(reading.used, window_, options)
      const headroomRaw =
        Number.isFinite(reading.threshold) && Number.isFinite(reading.used)
          ? Math.max(0, reading.threshold - reading.used)
          : undefined
      const headroom =
        band === 'unknown' || headroomRaw === undefined
          ? undefined
          : quantizeHeadroom(headroomRaw, window_, options)
      lastText = render(
        band,
        {
          quantized,
          step: displayStep(window_, options),
          headroom,
          headroomStep:
            headroomRaw === undefined ? undefined : headroomDisplayStep(headroomRaw, window_, options),
          headroomRaw,
          used: reading.used,
          window: window_,
          threshold: reading.threshold,
          percent: Number.isFinite(quantized) ? percentOf(quantized, window_) : percentOf(reading.used, window_),
        },
        options,
      )
      return lastText
    } catch {
      // A prompt assembly must never fail because a reading failed.
      return lastText
    }
  }

  ctx.systemPrompt.variable(VARIABLE_NAME, (assembly) => line(assembly))
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: options.order,
    text: `{{${VARIABLE_NAME}}}`,
  })
}

/** Test-only surface: the pure helpers, so the suite can exercise them directly. */
export const internals = {
  DEFAULT_OPTIONS,
  DEFAULT_COMPACTION_RULES,
  resolveOptions,
  formatTokens,
  percentOf,
  readOccupancy,
  rawBand,
  settleBand,
  quantize,
  quantizeHeadroom,
  headroomDisplayStep,
  displayStep,
  render,
  renderUnknown,
  messageText,
  patchCompactionInstruction,
  patchCompactionRequest,
  isCompactionRequest,
  isTaggedCompactionRequest,
}
