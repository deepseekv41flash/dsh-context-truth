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
 * ONE PEER IMPORT, STILL NO BUILD: the sole import is
 * `@deepseek-ai/schemastery` — the host's own schema package, declared as a peer
 * dependency. It is published on npm, so npm installs it with the plugin, and
 * the host that runs the plugin already ships it. It exists only so the settings
 * page can render a form for the options below: the host reads a plugin's form
 * from `fiber.runtime.Config`, and only a real schema (something with `toJSON`)
 * is accepted. Everything else stays dependency-free ESM, and this file is both
 * the source and the runtime artifact (`lib/index.js`).
 */
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (loader diagnostics, and the runtime-context section name). */
export const name = 'context-truth'

/** Prompt context name; must be unique per layer. */
export const CONTEXT_NAME = 'context-truth'

/** Prompt variable carrying the rendered line. */
export const VARIABLE_NAME = 'context_occupancy'

/**
 * Services that must be wired before this plugin can act.
 *
 * `systemPrompt` carries the line and `tokenMeter` supplies the authoritative
 * reading; both resolve in a plugin context.
 *
 * `compaction` IS DELIBERATELY ABSENT. Declaring it left this entry `pending
 * (waiting for service: compaction)` forever — the plugin stopped loading
 * entirely, taking the occupancy line with it — because in this build the
 * compaction engine is provided inside a scope no plugin context can reach.
 * Probed live: `ctx.get`, `ctx.reflect.get(name, false)`, `ctx.compaction` and
 * even a running `agent.ctx` all return nothing for `compaction`, while
 * `tokenMeter` resolves on all of them. See `installIdleFold` for what that means
 * for capability 3.
 */
export const inject = ['systemPrompt', 'tokenMeter']

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
   * Mirror of the mounted compaction backend's policy. Keep these equal to the
   * profile's compaction config; the line only reports the point, it never
   * enforces it.
   *
   * 0.7 rather than upstream's 0.8 because this profile runs `@aiwayds/dsh-dcp`,
   * whose bundle sets `thresholdRatio: 0.7` (verified against the live engine:
   * thresholdRatio=0.7, headroomTokens=65536, retainRatio=0.16). The displayed
   * point is unchanged either way — the budget term binds at 678,464 — but the
   * mirror must match for the case where it does not.
   */
  thresholdRatio: 0.7,
  headroomTokens: 65536,
  /** Reserved completion tokens; `null` reads the routed request's own maxTokens. */
  reservedCompletionTokens: null,
  /** Band edges as a fraction of the auto-compaction point. */
  moderateAt: 0.5,
  tightAt: 0.85,
  /** Fraction of the compaction point a reading must fall back below to leave a band. */
  hysteresis: 0.05,
  /**
   * Closing sentence of the `tight` band. `none` (default) lets the numbers speak
   * and leaves the decision to the model; `inform` states what the fold costs;
   * `stop` restores the 0.1.3 imperative that told it to finish the step and
   * hand off.
   */
  tightAdvice: 'none',
  /**
   * Display quantum as a percentage of the window. The rendered text changes
   * only when the reading crosses a quantum, which is what keeps re-injection
   * (and therefore cache churn) rare. 0 disables quantization — do not: the
   * snapshot would then be re-committed on every single step.
   */
  quantumPercent: 5,
  /**
   * Translate the remaining headroom into this session's own pace ("~6 more
   * steps"). Display-only: it never moves a band edge, the threshold, or the
   * decision to fold. It needs the host's per-step counter (`agent.phase`); when
   * that is absent the clause is omitted rather than guessed.
   */
  paceEstimate: true,
  /** Recent per-step deltas the estimate takes the median of. */
  paceSamples: 16,
  /** Samples required before any estimate is shown. */
  paceMinSamples: 3,
  /** Margin a higher rung must clear before the line promises more steps. */
  paceMargin: 0.25,
  /** Append the "this line is the only authority" clause. */
  authoritative: true,
  /** Add the explicit "earlier claims are stale" clause to the calm band. */
  staleClaimClause: true,
  /**
   * Report how much of the window is still unused. This is the figure that
   * answers "how much context do I have left" — the headroom figure answers
   * "how far to the fold", and conflating them is what produced "Very low
   * context" next to 350K of free window.
   */
  freeClause: true,
  /**
   * Define what the fold is in the `tight` and `critical` bands. Without it the
   * remaining-room figure reads as "context left" rather than "room before a
   * routine reorganization", which is what a live model acted on.
   */
  foldClause: true,
  /** Log each band change through ctx.logger, when a logger is present. */
  logBandChanges: true,
  /** Append `compactionRules` to the summarizer directive. */
  patchCompactionPrompt: true,
  /** Rules appended to the summarizer directive; `[]` disables the append. */
  compactionRules: DEFAULT_COMPACTION_RULES,
  /**
   * Fold at the idle boundary once the reading is within `foldAtIdleMarginPercent`
   * of the compaction point.
   *
   * The host's automatic compaction is a *crossing* trigger, and the behaviour it
   * produces near the point — batching, avoiding risky edits, stopping
   * mid-iteration to commit WIP — is exactly what keeps the reading just below it.
   * Measured on a live session: four hours with no fold, every turn two to eight
   * steps long, and three consecutive "continue" instructions unable to finish one
   * task. Folding at the model's own turn boundary breaks that loop, and the
   * official engine only accepts `compactNow` while the agent is idle, which is
   * precisely when this fires.
   *
   * Off by default: it spends a summarizer call and rewrites the window, which is
   * a policy decision rather than telemetry.
   */
  foldAtIdle: false,
  /** Headroom, as a percent of the window, at or below which the idle fold fires. */
  foldAtIdleMarginPercent: 5,
  /**
   * How the fold is requested.
   *
   * `command` (the preferred half of `auto`) runs the session's own `/compact`
   * through the **agent's** command view, so the fold is executed by whichever
   * backend that agent's realm mounts — the same engine a human's `/compact`
   * reaches. That matters twice over: it is the only path that works on a stock
   * deployment (upstream discussion 9425: a profile-scope plugin cannot inject a
   * preset realm's `compaction` service), and it keeps the summary style
   * consistent with the folds the session would get on its own.
   *
   * `service` calls `ctx.compaction.compactNow()` directly, which is all a
   * same-scope provider needs (e.g. `@aiwayds/dsh-dcp`) and is the only option
   * when the realm registers no `compact` command.
   *
   * `auto` tries the command first and falls back to the service.
   */
  foldAtIdleMethod: 'auto',
  /** Minimum gap between idle-fold attempts, so a failure cannot hammer the engine. */
  foldAtIdleCooldownMs: 60000,
}

/**
 * Settings schema. The host turns a plugin's `Config` into a form on the settings
 * page and writes edits back into the profile patch, so every option is
 * switchable without editing YAML. Defaults here mirror `DEFAULT_OPTIONS`;
 * `resolveOptions` stays the only place that interprets them, so a value the form
 * never writes behaves exactly like one it does.
 *
 * `.volatile()` ON EVERY FIELD (EXCEPT `enabled`) IS LOAD-BEARING. The settings
 * service builds its form with `volatileForm(schema)`, which keeps only nodes
 * marked volatile and drops the whole entry when nothing survives — a schema
 * without a single marker renders **no form at all**, silently. Volatile is also
 * the truth: the loader commits such a change straight into the running
 * reference (`_commitVolatile`) instead of reloading the plugin, which is why
 * `apply` reads its options through a resolver rather than a snapshot. `enabled`
 * is deliberately left out: it decides whether the context line is registered at
 * all, and the plugin list already carries an on/off switch for that.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  order: z.number().default(DEFAULT_ORDER).volatile(),
  language: z.string().default('en').volatile(),
  showAutoCompactionPoint: z.boolean().default(true).volatile(),
  thresholdRatio: z.number().default(0.7).volatile(),
  headroomTokens: z.number().step(1).min(0).default(65536).volatile(),
  reservedCompletionTokens: z.number().step(1).min(0).volatile(),
  moderateAt: z.number().default(0.5).volatile(),
  tightAt: z.number().default(0.85).volatile(),
  hysteresis: z.number().min(0).default(0.05).volatile(),
  tightAdvice: z.string().default('none').volatile(),
  quantumPercent: z.number().min(0).default(5).volatile(),
  paceEstimate: z.boolean().default(true).volatile(),
  paceSamples: z.number().step(1).min(2).default(16).volatile(),
  paceMinSamples: z.number().step(1).min(1).default(3).volatile(),
  paceMargin: z.number().min(0).default(0.25).volatile(),
  authoritative: z.boolean().default(true).volatile(),
  staleClaimClause: z.boolean().default(true).volatile(),
  freeClause: z.boolean().default(true).volatile(),
  foldClause: z.boolean().default(true).volatile(),
  logBandChanges: z.boolean().default(true).volatile(),
  patchCompactionPrompt: z.boolean().default(true).volatile(),
  // A field with no schema default is materialized as `[]`, and `[]` means "append
  // nothing" here — so the default must carry the real rules, or merely adding the
  // schema switches capability 2 off. Found live: the running config read
  // `compactionRules: []` and the summarizer directive went unpatched.
  compactionRules: z.array(z.string()).default(DEFAULT_COMPACTION_RULES).volatile(),
  foldAtIdle: z.boolean().default(false).volatile(),
  foldAtIdleMarginPercent: z.number().min(0.1).max(50).default(5).volatile(),
  foldAtIdleMethod: z.string().default('auto').volatile(),
  foldAtIdleCooldownMs: z.number().step(1).min(0).default(60000).volatile(),
})

/** Clamp a numeric option, falling back when it is not a finite number. */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The marker `cosmokit` puts on a volatile config reference. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Materialize one config value.
 *
 * A field declared `.volatile()` is stored by the host as a live *reference*, not
 * a plain value — that is the mechanism that lets the settings page change an
 * option without reloading the plugin (`loader._commitVolatile` writes into the
 * running reference). So `ctx.config` hands this plugin reference objects, and
 * the host's own adapters unwrap them the same way (`plainOptions`). Detection is
 * structural and matches `cosmokit.isVolatile`.
 */
function plainValue(value) {
  if (
    value !== null &&
    typeof value === 'object' &&
    VOLATILE_WRITE in value &&
    typeof value.get === 'function'
  ) {
    return plainValue(value.get())
  }
  return value
}

/** Materialize a whole config object, one level deep, as the host does. */
function plainConfig(config) {
  if (config === null || typeof config !== 'object') return config
  const out = {}
  for (const [key, value] of Object.entries(config)) out[key] = plainValue(value)
  return out
}

/** Merge user config over the defaults with light validation. */
function resolveOptions(config) {
  const raw = plainConfig(config)
  const merged = raw !== null && typeof raw === 'object' ? { ...DEFAULT_OPTIONS, ...raw } : DEFAULT_OPTIONS
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
    tightAdvice:
      merged.tightAdvice === 'stop' ? 'stop' : merged.tightAdvice === 'inform' ? 'inform' : 'none',
    foldClause: merged.foldClause === true,
    freeClause: merged.freeClause === true,
    quantumPercent: Math.max(0, num(merged.quantumPercent, DEFAULT_OPTIONS.quantumPercent)),
    paceEstimate: merged.paceEstimate === true,
    paceSamples: Math.max(2, Math.round(num(merged.paceSamples, DEFAULT_OPTIONS.paceSamples))),
    paceMinSamples: Math.max(1, Math.round(num(merged.paceMinSamples, DEFAULT_OPTIONS.paceMinSamples))),
    paceMargin: Math.max(0, num(merged.paceMargin, DEFAULT_OPTIONS.paceMargin)),
    compactionRules: rules,
    foldAtIdle: merged.foldAtIdle === true,
    foldAtIdleMarginPercent: Math.min(
      50,
      Math.max(0.1, num(merged.foldAtIdleMarginPercent, DEFAULT_OPTIONS.foldAtIdleMarginPercent)),
    ),
    foldAtIdleMethod:
      merged.foldAtIdleMethod === 'command' || merged.foldAtIdleMethod === 'service'
        ? merged.foldAtIdleMethod
        : 'auto',
    foldAtIdleCooldownMs: Math.max(
      0,
      num(merged.foldAtIdleCooldownMs, DEFAULT_OPTIONS.foldAtIdleCooldownMs),
    ),
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

/** Read a wired service by property for diagnostics; never throws. */
function serviceOr(ctx, key) {
  try {
    return ctx[key]
  } catch {
    return undefined
  }
}

/**
 * Name the mounted compaction backend by its prototype chain, for diagnostics.
 *
 * Which backend owns the seam decides two things this plugin cares about: whether
 * a fold can be requested at all (`compactNow` reachable from a plugin context —
 * the stock backend is not, see upstream discussion 9425), and whether capability
 * 2 has anything to patch (a deterministic backend makes no summarizer call, so
 * the directive rules never apply).
 *
 * @returns the chain, or `none` when no service is reachable.
 */
function backendIdentity(service) {
  try {
    if (!isService(service)) return 'none'
    const chain = []
    let proto = Object.getPrototypeOf(service)
    while (proto !== null && proto.constructor !== undefined && chain.length < 5) {
      if (proto.constructor.name === 'Object') break
      chain.push(proto.constructor.name)
      proto = Object.getPrototypeOf(proto)
    }
    return chain.length === 0 ? 'anonymous' : chain.join('>')
  } catch {
    return 'unknown'
  }
}

/** Resolve a service that may or may not be mounted, without ever throwing. */
function safeGet(ctx, key) {
  let viaMethod
  try {
    viaMethod = ctx.get(key)
  } catch {
    viaMethod = undefined
  }
  if (isService(viaMethod)) return viaMethod
  let viaProperty
  try {
    viaProperty = ctx[key]
  } catch {
    viaProperty = undefined
  }
  return isService(viaProperty) ? viaProperty : undefined
}

/**
 * Whether a value is a reachable service.
 *
 * Load-bearing: cordis answers a property read for a service this fiber does not
 * have with a **string** ("not injected" style diagnostics), not `undefined`. An
 * earlier revision accepted anything non-undefined, so the idle fold concluded it
 * had a service and then failed the `compactNow` shape check — and the "no service
 * mounted" warning fired on every trigger while the real reason stayed invisible.
 */
function isService(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/**
 * Read the host's own occupancy figure for one session.
 * @returns `{ used, window, reserved, threshold }`; any field may be `undefined`.
 */
function readOccupancy(ctx, session, options, injectedMeter) {
  const result = {}
  let used
  let window_

  // `injectedMeter` is a resolver (see `apply`), not a value: reading it per use
  // follows a host that swaps the service.
  let meter
  if (injectedMeter !== undefined) {
    try {
      meter = injectedMeter()
    } catch {
      meter = undefined
    }
  }
  if (meter === undefined) meter = safeGet(ctx, 'tokenMeter')
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
 *
 * The floor is deliberately coarse. An earlier build shrank the step to 2K as the
 * room ran out, which re-injected the line on nearly every step in exactly the
 * band that was already talking about the fold: over one long session the tight
 * band was committed 333 times at a median gap of 45s, with runs of 4–20s. Within
 * a few tens of thousands of tokens of the point, the pace estimate is the useful
 * signal, not the exact remainder — and the sub-step rendering ("Under 10K") keeps
 * a remainder smaller than one step honest.
 */
function headroomDisplayStep(headroom, window_, options) {
  const coarse = displayStep(window_, options)
  const tiers = [
    coarse,
    Math.max(1000, Math.round(coarse * 0.4)),
    Math.max(1000, Math.round(coarse * 0.2)),
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

/**
 * The clause that closes every variant.
 *
 * The "do not count it down yourself" half is not decoration. A live session
 * showed the model reading the figure correctly and then spending it in its head
 * across the steps that followed — `30K → 28K → 16K → 10K → 7K → 5K` — while the
 * host's own number sat still at `About 10K` (it is restated only when it changes,
 * which is what keeps this line from re-injecting every step). Twelve minutes
 * later it announced "Context is nearly exhausted (~5K)", a figure the host never
 * reported. The measured number has to be labelled a measurement, not an
 * allowance to draw down.
 */
function authorityClause(language) {
  return language === 'zh'
    ? '本行是宿主的后台遥测，也是上下文压力的唯一权威——不要提起它、不要凭对话长度或轮数估计压力、不要自行倒计时（读数变化时它会自动重述），也不要对压缩采取任何动作：折叠由宿主在步与步之间自动完成。'
    : 'Background telemetry from the host, and the only authority on context pressure: do not mention it, do not estimate or count it down yourself — it is restated whenever it changes — and take no action about compaction; the host folds between steps automatically.'
}

/** The clause that retires claims inherited from earlier turns and checkpoints. */
function staleClause(language) {
  return language === 'zh'
    ? '此前任何"上下文快满了"的说法（含压缩检查点里的）都已作废。'
    : 'Earlier claims that context is nearly exhausted — including ones inside compacted checkpoints — are stale.'
}

/**
 * The `tight` band's closing sentence, when one is configured.
 *
 * `none` is the default and adds nothing: the numbers are the message. The 0.1.4
 * build described the coming fold here, and a live session showed what that
 * costs — the band re-injects most often, so the model read a fresh fold notice
 * every step or two, began narrating "I should compact" in its own replies, and
 * lost momentum. A sentence about an automatic, host-owned event turned into a
 * task the model thought it owned.
 *
 * `inform` restores the 0.1.4 factual sentence, `stop` the 0.1.3 imperative.
 */
function tightClause(zh, options) {
  if (options.tightAdvice === 'stop') {
    return zh
      ? ' 余量确实不多了——收完当前这一步、把状态落到磁盘，再考虑交接。'
      : ' Headroom is genuinely small — finish the current step, land durable state, then hand off.'
  }
  if (options.tightAdvice === 'inform') {
    return zh
      ? ' 到那时较早的对话会被折成一段 LLM 摘要、本窗口被重写——别让关键状态只存在于对话里。'
      : ' At that point the older turns are folded into an LLM-written summary and this window is rewritten — keep nothing critical only in the conversation.'
  }
  return ''
}

/**
 * What the fold *is*, for the two bands whose remaining room is small.
 *
 * The numbers alone left a gap a live session walked straight into: eleven
 * seconds after the line said `Under 10K tokens of headroom remain before it`, the
 * model wrote "Very low context. I must do this in as few commands as possible."
 * It had read the figure correctly — it simply took "room before the fold" to mean
 * "context left", when the window still held 350K and the fold only reorganizes
 * it. This clause is that missing definition, stated as a fact: it orders nothing,
 * so it cannot become the "finish the step and hand off" nudge of 0.1.3.
 *
 * `brief` is for the `critical` band, which already says a fold is expected and
 * only needs the part that defuses "exhausted".
 */
function foldClause(zh, options, brief = false) {
  if (options.foldClause !== true) return ''
  if (brief) {
    return zh ? ' 窗口并未耗尽——折叠之后工作照常继续。' : ' The window is not exhausted — work continues after the fold.'
  }
  return zh
    ? ' 折叠是例行操作，不是窗口的终点：较早的对话会被折成摘要，之后工作照常继续。'
    : ' The fold is routine, not the end of the window: older turns become a summary and work continues after it.'
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

/**
 * Step-count ladder for the pace estimate. Coarse on purpose: the runtime
 * snapshot is re-committed only when its bytes change, so a figure that drifts
 * every step would cost more in re-injection than it explains. The rendered rung
 * moves only when the estimate crosses it.
 *
 * The top rung is open-ended (`20+`) because that is where the estimate is both
 * least useful and most volatile: a live session's raw count ranged 23–38 across
 * consecutive steps, which straddled a `21 / 34` boundary and flipped the line
 * five times in 90 seconds. Above ~20 steps the exact figure changes no decision.
 */
const PACE_LADDER = [1, 2, 3, 5, 8, 13, 20]

/** Median of a small numeric array; does not mutate the input. */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Fold one prompt assembly into the per-session pace state.
 *
 * Sampling happens ONLY when the host's `(turn, step)` pair advances. One step
 * can assemble more than once — retries, the compaction summarizer, session
 * titling — and those extra assemblies are not work and must not enter the
 * average as if they were.
 *
 * A negative delta means the meter re-based because a fold landed (measured in
 * this deployment: 200K -> under 50K within three seconds). The history is
 * dropped instead of being averaged against it, otherwise a single fold poisons
 * the estimate for many steps afterwards. The estimate is the median of the
 * recent positive deltas, so one 30K tool dump cannot drag it; a step that added
 * nothing is not evidence about pace and is ignored.
 *
 * @returns `{ state, perStep, samples }`; `perStep` stays undefined until
 * `paceMinSamples` samples exist, and stays undefined when the host exposes no
 * step counter at all.
 */
function nextPaceState(previous, sample, options) {
  const turn = sample === undefined || sample === null ? undefined : sample.turn
  const step = sample === undefined || sample === null ? undefined : sample.step
  const used = sample === undefined || sample === null ? undefined : sample.used
  const observed = previous === undefined || previous === null ? undefined : previous

  // No usable counter: keep whatever state we already have.
  if (!Number.isFinite(turn) || !Number.isFinite(step) || !Number.isFinite(used)) {
    return { state: observed, perStep: observed?.perStep, samples: observed?.recent.length ?? 0 }
  }
  if (observed === undefined) return { state: { turn, step, used, recent: [] }, perStep: undefined, samples: 0 }

  // Same step assembled again: no new work, so nothing is sampled.
  if (observed.turn === turn && observed.step === step) {
    return { state: observed, perStep: observed.perStep, samples: observed.recent.length }
  }

  const delta = used - observed.used
  const recent =
    delta < 0
      ? []
      : delta === 0
        ? observed.recent
        : [...observed.recent, delta].slice(-options.paceSamples)
  const perStep = recent.length >= options.paceMinSamples ? median(recent) : undefined
  return { state: { turn, step, used, recent, perStep }, perStep, samples: recent.length }
}

/**
 * The estimate for one assembly, keeping per-session state in `store`.
 * Undefined whenever the feature is off, the host has no step counter, or the
 * session is too young — in which case the clause is absent, not zero.
 */
function samplePace(store, session, assembly, used, options) {
  if (options.paceEstimate !== true || !Number.isFinite(used)) return undefined
  const agent = assembly === undefined || assembly === null ? undefined : assembly.agent
  const phase = agent === undefined || agent === null ? undefined : agent.phase
  const next = nextPaceState(store.get(session), { turn: phase?.turn, step: phase?.step, used }, options)
  if (next.state !== undefined) store.set(session, next.state)
  return next.perStep
}

/** Whole steps the remaining headroom covers at the observed rate. */
function paceSteps(headroom, perStep) {
  if (!Number.isFinite(headroom) || headroom < 0) return undefined
  if (!Number.isFinite(perStep) || perStep <= 0) return undefined
  return Math.floor(headroom / perStep)
}

/** Index of the largest ladder rung a step count still reaches, or undefined. */
function paceRung(steps) {
  if (!Number.isFinite(steps) || steps < 1) return undefined
  let index = 0
  for (let i = 0; i < PACE_LADDER.length; i += 1) if (steps >= PACE_LADDER[i]) index = i
  return index
}

/**
 * Settle the rung the line publishes.
 *
 * The estimate's own wobble is wider than one rung, so publishing it raw made the
 * line flip: measured in a live session, `13 -> 21 -> 34+ -> 21 -> 34+` inside 90
 * seconds, where one snapshot re-commit was caused by nothing but the flip (the
 * headroom and the band were both unchanged). The rung therefore settles the way
 * a band does, and asymmetrically:
 *
 * - downward — fewer remaining steps, i.e. less room promised — takes effect at
 *   once, the same direction the headroom itself rounds;
 * - upward — promising more room — must clear the higher rung by `paceMargin`,
 *   so a straddling estimate cannot flip the line, while a genuinely slower
 *   session still gets the higher figure (the rule cannot freeze).
 *
 * @returns `{ state, steps }`, where `steps` re-derives the rung to render.
 */
function settlePace(steps, previous, options) {
  const index = paceRung(steps)
  if (index === undefined) return { state: previous, steps: undefined }
  if (previous === undefined || previous === null || !Number.isFinite(previous.published)) {
    return { state: { published: index }, steps: PACE_LADDER[index] }
  }
  if (index <= previous.published) return { state: { published: index }, steps: PACE_LADDER[index] }
  const required = PACE_LADDER[index] * (1 + Math.max(0, options.paceMargin))
  if (steps >= required) return { state: { published: index }, steps: PACE_LADDER[index] }
  return { state: previous, steps: PACE_LADDER[previous.published] }
}

/**
 * The pace clause, bucketed onto {@link PACE_LADDER}.
 *
 * The rung is the largest one the estimate still reaches, so the figure rounds
 * DOWN like the headroom does: the line must never promise more remaining steps
 * than the session's own rate supports. The top rung renders as "34+".
 */
function paceSentence(steps, zh) {
  if (!Number.isFinite(steps) || steps < 1) return ''
  let rung = PACE_LADDER[0]
  for (const edge of PACE_LADDER) if (steps >= edge) rung = edge
  const open = rung === PACE_LADDER[PACE_LADDER.length - 1]
  const label = open ? `${rung}+` : String(rung)
  const plural = rung === 1 ? '' : 's'
  return zh
    ? ` 按本会话近期节奏，这点余量约合 ${label} 步。`
    : ` At this session's recent rate that is roughly ${label} more step${plural}.`
}

/** Render the reading for one band. Pure: same inputs, same bytes. */
function render(band, reading, options) {
  const zh = options.language === 'zh'
  const parts = []
  if (options.authoritative) parts.push(authorityClause(options.language))
  if (band === 'ample' && options.staleClaimClause) parts.push(staleClause(options.language))
  const tail = parts.length === 0 ? '' : ` ${parts.join(' ')}`

  // The estimate qualifies the remaining headroom, so it rides only on the two
  // bands where that headroom is the decision at hand — together with the
  // definition of what the fold is, without which the figure reads as "context
  // left" rather than "room before a routine reorganization".
  const pace = band === 'tight' || band === 'critical' ? paceSentence(reading.steps, zh) : ''
  const fold =
    band === 'tight'
      ? foldClause(zh, options)
      : band === 'critical'
        ? foldClause(zh, options, true)
        : ''

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
  // How much of the window is still unused — the figure that actually answers
  // "how much context do I have left?". The headroom above answers a different
  // question ("how far to the fold"), and a live model answered the first with
  // the second: "Very low context" at 10K of headroom, while 350K of the window
  // was free. Quantized onto the same step as `used`, so it moves on exactly the
  // same crossings and costs no extra re-injection.
  const freeRaw = reading.freeRaw
  const flooredFree = reading.free === 0 && Number.isFinite(freeRaw) && freeRaw > 0
  const free =
    options.freeClause !== true || !Number.isFinite(reading.free)
      ? ''
      : flooredFree && step !== undefined
        ? zh
          ? ` 窗口还有${underStep(step, zh)} 未使用。`
          : ` Under ${formatTokens(step)} of the window is still free.`
        : zh
          ? ` 窗口还有约 ${formatTokens(reading.free)} 未使用。`
          : ` About ${formatTokens(reading.free)} of the window is still free.`
  // Nothing left to report once the reading has reached the point: "About 0
  // tokens of headroom remain" is noise on the one line that should stay calm.
  const remaining =
    head === undefined || reading.headroomRaw === 0
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
        ? `${head0}${free}${point}${remaining} 上下文不紧张——不要因为"上下文不够"而收尾、交接子代理或缩小范围。${tail}`
        : `${head0}${free}${point}${remaining} Context is NOT scarce — do not wrap up, hand off to a subagent, or narrow scope for context reasons.${tail}`
    case 'moderate':
      return zh
        ? `${head0}${free}${point}${remaining} 仍有充足余量，继续推进即可，顺手把关键状态写进文档或提交。${tail}`
        : `${head0}${free}${point}${remaining} There is still real headroom — keep going, and keep durable notes or commits current as you work.${tail}`
    case 'tight':
      return `${head0}${free}${point}${remaining}${pace}${fold}${tightClause(zh, options)}${tail}`
    default:
      return zh
        ? `${head0}${free}${point}${remaining}${pace}${fold} 已到或越过自动压缩点——接下来可能发生压缩折叠，别让关键状态只存在于本窗口。${tail}`
        : `${head0}${free}${point}${remaining}${pace}${fold} At or past the automatic compaction point — expect earlier turns to be folded; keep nothing critical only in this window.${tail}`
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
  // Read options through this on every use. A field declared `.volatile()` is a
  // live reference, so a settings change lands here without reloading the plugin
  // — a snapshot taken once at apply time would silently ignore every later
  // toggle. The listeners below are therefore installed unconditionally and gate
  // themselves per event instead of at install time.
  const resolve = () => resolveOptions(config)

  // Services are acquired through `ctx.inject`, not `ctx.get`. `get` resolves
  // through `ctx.reflect` and returned nothing for `compaction` in a live
  // deployment: the idle fold's first real trigger (22:44, inside the margin, at
  // an idle boundary) logged "no compaction service is mounted" and folded
  // nothing. Injecting also keeps this plugin loading on deployments that mount
  // no compaction service at all, since the callback simply never runs.
  // Services are read per use through the proxy cordis wires for the declared
  // injections, never snapshotted: a host that swaps an implementation (or
  // provides one only later) must be followed. `readOccupancy` and the fold also
  // fall back to `safeGet`, which costs nothing and keeps the plugin usable if a
  // deployment resolves the names differently.
  const services = {
    meter: () => ctx.tokenMeter,
    // `ctx.compaction` answers with a diagnostic string when the service is not
    // reachable, which `isService` rejects; the fold therefore stays inactive and
    // logs why, once, instead of failing per trigger.
    compaction: () => ctx.compaction,
  }
  const compactionService = serviceOr(ctx, 'compaction')
  logLine(
    ctx,
    'info',
    'context-truth: services wired (tokenMeter=%s compaction=%s/%s)',
    typeof serviceOr(ctx, 'tokenMeter'),
    typeof compactionService,
    backendIdentity(compactionService),
  )

  if (resolve().enabled) {
    try {
      installContextLine(ctx, resolve, services)
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

  installCompactionPatch(ctx, resolve)
  installIdleFold(ctx, resolve, services)
}

/** Whether a registration failed because the name is already taken in this layer. */
function isAlreadyRegistered(error) {
  return error instanceof Error && error.message.includes('already registered')
}

/** Install the `llm/stream` listener that extends the summarizer directive. */
function installCompactionPatch(ctx, resolve) {
  let warned = false
  ctx.on('llm/stream', (request, next) => {
    try {
      const options = resolve()
      if (!options.patchCompactionPrompt || options.compactionRules.length === 0) return next()
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

/** Log through the host logger when present; logging must never break a turn. */
function logLine(ctx, level, format, ...args) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](format, ...args)
  } catch {
    // A logger that throws is the logger's problem, not the turn's.
  }
}

/**
 * Whether an idle session is close enough to the compaction point that its next
 * turns would be short sprints. Pure, so the decision is testable without stubs.
 *
 * @param reading - `{ used, threshold, window }` as returned by `readOccupancy`.
 * @param options - resolved plugin options.
 * @returns `{ fold }` plus the numbers behind the decision, for the log line.
 */
function shouldFoldAtIdle(reading, options) {
  if (options.foldAtIdle !== true) return { fold: false }
  const used = reading === null || reading === undefined ? undefined : reading.used
  const threshold = reading === null || reading === undefined ? undefined : reading.threshold
  const window_ = reading === null || reading === undefined ? undefined : reading.window
  if (!Number.isFinite(used) || !Number.isFinite(threshold) || threshold <= 0) return { fold: false }
  if (!Number.isFinite(window_) || window_ <= 0) return { fold: false }
  const margin = Math.round((window_ * options.foldAtIdleMarginPercent) / 100)
  const headroom = Math.round(threshold - used)
  return { fold: headroom <= margin, headroom, margin }
}

/**
 * Fold at the idle boundary when the session is nearly out of room. See
 * `foldAtIdle` in DEFAULT_OPTIONS for why the host's crossing trigger is not
 * enough on its own. Every failure is logged and swallowed, and an attempt is
 * rate-limited: a trigger must never break a turn or hammer the engine.
 */
function installIdleFold(ctx, resolve, services) {
  let inFlight = false
  let attemptedAt = 0
  let warnedNoService = false
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle' || agent === null || agent === undefined) return
    const options = resolve()
    if (options.foldAtIdle !== true) return
    if (inFlight || Date.now() - attemptedAt < options.foldAtIdleCooldownMs) return
    let decision
    try {
      const session = agent.session
      if (session === null || session === undefined) return
      decision = shouldFoldAtIdle(readOccupancy(ctx, session, options), options)
    } catch {
      return
    }
    if (!decision.fold) return
    inFlight = true
    attemptedAt = Date.now()
    const signal = new AbortController().signal
    Promise.resolve()
      .then(() => requestFold(ctx, agent, options, services, signal))
      .then(
        (how) => {
          if (how === undefined) {
            if (!warnedNoService) {
              warnedNoService = true
              logLine(
                ctx,
                'warn',
                'context-truth: foldAtIdle is enabled, but neither the realm /compact command nor a reachable compaction service answered (upstream discussion 9425); the idle fold stays inactive',
              )
            }
            return
          }
          logLine(
            ctx,
            'info',
            'context-truth: folded at idle via %s (headroom=%s margin=%s)',
            how,
            decision.headroom,
            decision.margin,
          )
        },
        (error) =>
          logLine(
            ctx,
            'warn',
            'context-truth: idle fold failed: %s',
            error === null || error === undefined ? 'unknown error' : (error.message ?? error),
          ),
      )
      .finally(() => {
        inFlight = false
      })
  })
}

/**
 * Ask for one fold, at the agent's own idle boundary.
 *
 * Two channels, in this order, and the order is the point:
 *
 * 1. `commands.execute(agent, '/compact', …)` runs the session's own slash
 *    command **through the agent's realm view**, so the fold lands on whichever
 *    backend that agent mounts — the same engine a human's `/compact` reaches.
 *    This is the only channel that works on a stock deployment: a plugin entry
 *    lives at profile scope and cannot inject a preset realm's `compaction`
 *    service (upstream discussion 9425). It is also the channel that keeps the
 *    summary style consistent with the session's own folds.
 * 2. `ctx.compaction.compactNow()` on a provider reachable from the plugin's own
 *    scope — the direct path, and the only one available when the realm registers
 *    no `compact` command (e.g. a preset that drops `command-compact`).
 *
 * @returns which channel answered, or `undefined` when neither could be reached.
 */
async function requestFold(ctx, agent, options, services, signal) {
  if (options.foldAtIdleMethod !== 'service') {
    const commands = safeGet(ctx, 'commands')
    if (commands !== undefined && typeof commands.execute === 'function') {
      try {
        await commands.execute(agent, '/compact', [], signal)
        return 'command'
      } catch (error) {
        // A realm without the command, or a refusal, is not fatal: the service
        // channel below is still worth trying.
        logLine(
          ctx,
          'info',
          'context-truth: /compact request did not fold (%s); trying the compaction service',
          error === null || error === undefined ? 'unknown error' : (error.message ?? error),
        )
      }
    }
  }
  if (options.foldAtIdleMethod === 'command') return undefined
  // Ranked candidates, and the winner is the first that actually carries
  // `compactNow` — never "the first that is not undefined".
  //
  // That distinction is load-bearing: a property read for a service this fiber
  // does not have answers with a **diagnostic string**, not `undefined` (the foot
  // gun reported in upstream discussion 9425). An earlier revision took that
  // string as "found", skipped the `ctx.get` candidate that would have worked,
  // and then failed its own shape check — so the fold silently never fired while
  // the service was reachable the whole time.
  const candidates = []
  try {
    candidates.push(safeGet(agent.ctx, 'compaction'))
  } catch {
    // an agent without its own context is expected
  }
  try {
    candidates.push(safeGet(ctx, 'compaction'))
  } catch {
    // a context without `get` is expected on some harnesses
  }
  if (services.compaction !== undefined) {
    try {
      candidates.push(services.compaction())
    } catch {
      // a wired property that throws is simply not a candidate
    }
  }
  const compaction = candidates.find(
    (candidate) => isService(candidate) && typeof candidate.compactNow === 'function',
  )
  if (compaction === undefined) return undefined
  await compaction.compactNow(agent, signal)
  return 'service'
}

/** Install the dynamic runtime-context line. */
function installContextLine(ctx, resolve, services) {
  /** Last band published per session (hysteresis memory); never rendered. */
  const bands = new WeakMap()
  /** Per-session pace state for the headroom estimate; never rendered raw. */
  const paces = new WeakMap()
  /** Last text handed out, so a failed read degrades to the previous line. */
  let lastText = renderUnknown(resolve())

  const line = (assembly) => {
    // Resolved per assembly, so a settings change shows up on the next prompt.
    const options = resolve()
    try {
      const session = assembly?.agent?.session
      if (session === undefined || session === null) return lastText

      const reading = readOccupancy(ctx, session, options, services.meter)
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
      // Sampled on every assembly so the state stays current even in bands that
      // do not render it; the rung settles before it is rendered.
      const perStep = samplePace(paces, session, assembly, reading.used, options)
      const settled = settlePace(paceSteps(headroomRaw, perStep), paces.get(session)?.pace, options)
      const sampled = paces.get(session)
      if (sampled !== undefined && settled.state !== undefined) {
        paces.set(session, { ...sampled, pace: settled.state })
      }
      const steps = settled.steps
      // Window still unused, on the same display step as `used` (floored, so it
      // never promises more room than the window has).
      const freeRaw =
        Number.isFinite(window_) && Number.isFinite(reading.used)
          ? Math.max(0, window_ - reading.used)
          : undefined
      const free = band === 'unknown' || freeRaw === undefined ? undefined : quantize(freeRaw, window_, options)
      lastText = render(
        band,
        {
          quantized,
          step: displayStep(window_, options),
          headroom,
          headroomStep:
            headroomRaw === undefined ? undefined : headroomDisplayStep(headroomRaw, window_, options),
          headroomRaw,
          free,
          freeRaw,
          steps,
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
    // `order` is fixed at registration: the host snapshots the contribution list
    // per assembly, and moving it live would reshuffle the cached prefix for a
    // change nobody asked to see mid-turn.
    order: resolve().order,
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
  PACE_LADDER,
  median,
  nextPaceState,
  samplePace,
  paceSteps,
  paceRung,
  settlePace,
  paceSentence,
  tightClause,
  foldClause,
  shouldFoldAtIdle,
  backendIdentity,
  render,
  renderUnknown,
  messageText,
  patchCompactionInstruction,
  patchCompactionRequest,
  isCompactionRequest,
  isTaggedCompactionRequest,
}
