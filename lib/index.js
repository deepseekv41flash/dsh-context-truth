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
 * THREE CAPABILITIES, ONE BELIEF TO KILL
 * --------------------------------------
 * 1. MEASUREMENT IN (default on). One dynamic runtime-context line, refreshed
 *    from the host's own token meter, re-injected only when the reading moves a
 *    display step. It adds no tool, no message, and no per-step noise — one
 *    stable paragraph that changes about a dozen times per compaction cycle.
 * 2. CLAIM FILTERING (default on). The compaction summarizer is told not to
 *    record the assistant's own guesses about its remaining budget, so the
 *    false belief stops being re-injected as established background.
 * 3. FOLD POLICY (`foldMode`, default idle). Who folds, and what the model knows
 *    before it happens. `idle` keeps the legacy turn-boundary fold; `handoff`
 *    asks the model for a handoff note at 85% of the fold point, folds at that
 *    round's end, and activates exactly one follow-up turn whose first job is to
 *    read the note back. The point of `handoff` is the cost `idle` leaves on the
 *    table: a fold the model did not see coming makes it rebuild its own
 *    picture from a summary, and long tasks pay for that in repeated work.
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
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (loader diagnostics, and the runtime-context section name). */
export const name = 'context-truth'

/** Prompt context name; must be unique per layer. */
export const CONTEXT_NAME = 'context-truth'

/** Prompt variable carrying the rendered line. */
export const VARIABLE_NAME = 'context_occupancy'

/**
 * The handoff reminder gets its own context contribution, so the snapshot shows
 * it as a separate block instead of growing the occupancy line. It renders empty
 * (and therefore contributes nothing at all) except on the one request that
 * carries a prepared reminder.
 */
export const HANDOFF_CONTEXT_NAME = 'context-truth:handoff'

/** Prompt variable carrying the handoff reminder, or an empty string. */
export const HANDOFF_VARIABLE_NAME = 'context_truth_handoff'

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
   * 0.7 is the value a `@aiwayds/dsh-dcp` bundle sets (verified against a live
   * engine: thresholdRatio=0.7, headroomTokens=65536, retainRatio=0.16); stock
   * compaction uses 0.8. ✗ Do not read this default as a statement about "this
   * machine": a profile that mounts no such provider (e.g. a stock Linux box) should
   * set `thresholdRatio: 0.8` to match what it actually runs. The displayed point is
   * often unchanged either way — the budget term binds at 727,040 on a 1M window with
   * 256K reserved — but the mirror must match for the cases where it does not.
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
  /**
   * Which fold policy owns the session. Capability 3, and the only option here
   * that changes *behaviour* rather than reporting.
   *
   * `off`     — another plugin (or the host's own pressure trigger) owns it.
   *             Folding spends a summarizer call and rewrites the window, so this
   *             is the opt-out for deployments that do not want it.
   * `idle`    — the legacy turn-boundary fold, and the DEFAULT. Folds when the
   *             idle reading is within `foldAtIdleMarginPercent` of the fold point.
   * `handoff` — EXPERIMENTAL. Handoff-first. The model is reminded at `handoffAt` ×
   *             the fold point, writes its own handoff note, registers it with
   *             `handoff_ready`, and the fold runs at that round's end. Exactly
   *             one follow-up turn is activated, and its first instruction is to
   *             read that note back before touching the task.
   */
  foldMode: 'idle',
  /**
   * Prep point as a fraction of the FOLD POINT (not of the window): at
   * `handoffAt` × fold point the handoff reminder is injected. 0.85 leaves the
   * model roughly one turn's worth of steps before the host's own pressure fold
   * would take the decision away from it.
   */
  handoffAt: 0.85,
  /**
   * Where handoff notes live. `''` means `$DSH_HOME/handoffs`, and a relative
   * value resolves under `$DSH_HOME`. Never the workspace: a note that lives in
   * the repo becomes project state, and it is recycled.
   */
  handoffDir: '',
  /**
   * How many prep reminders one fold cycle may inject (each lands at most once
   * per turn). After the budget is spent the host's pressure fold takes over,
   * which is the behaviour this mode exists to improve on — so keep it above 1.
   */
  handoffReminders: 3,
  /**
   * Extend the handoff reminder to DELEGATED sessions (default off).
   *
   * A delegate gets no fold from this plugin — the host's pressure fold owns it —
   * so this is deliberately the reduced shape: remind it past the prep point, let
   * the plain file be the registration (a child never gets `handoff_ready`), and
   * after the fold point hand it a pointer back to that note. No wake and no fold:
   * a delegate's turns belong to whoever delegated it, and a `followup` injected
   * into that arrangement would break the parent's sequencing.
   *
   * Off by default because it changes what every child session's model is told,
   * and most children never get near the prep point (measured on this host: 8 of
   * 116 delegated sessions were ever folded, 6.9%).
   */
  subagentHandoff: false,
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
  /**
   * Legacy switch, read only by `resolveFoldMode`. NO `.default()` on purpose: a
   * materialized `false` would make every untouched config look like an explicit
   * opt-out, and the resolver could no longer tell "never set" (→ `idle`) from
   * "set to false" (→ `off`).
   */
  foldAtIdle: z.boolean().volatile(),
  foldAtIdleMarginPercent: z.number().min(0.1).max(50).default(5).volatile(),
  foldAtIdleMethod: z.string().default('auto').volatile(),
  foldAtIdleCooldownMs: z.number().step(1).min(0).default(60000).volatile(),
  /**
   * NO `.default()` HERE, AND THAT IS LOAD-BEARING. An absent key is the only way
   * this plugin can tell "the user never chose a mode" apart from "the user chose
   * a mode", and that distinction is what makes the compatibility rules safe: a
   * config written before `foldMode` existed resolves to `idle` (folding at the
   * model's own turn boundary is what it already did), a config that explicitly
   * set `foldAtIdle: false` keeps opting out, and a config the settings form has
   * touched stays exactly where it was put. `resolveOptions` is the only reader,
   * so an absent key never reaches runtime.
   */
  foldMode: z.union([z.const('off'), z.const('idle'), z.const('handoff')]).volatile(),
  handoffAt: z.number().min(0.5).max(0.95).default(0.85).volatile(),
  handoffDir: z.string().default('').volatile(),
  handoffReminders: z.number().step(1).min(0).default(3).volatile(),
  subagentHandoff: z.boolean().default(false).volatile(),
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

/**
 * Resolve the fold mode, with `foldAtIdle` as the deprecated spelling of `idle`.
 *
 * `raw` is the validated config, not the merged defaults: the schema leaves
 * `foldMode` defaultless on purpose so that a missing key is observable here.
 *
 * DEFAULT = `idle`: folding at the model's own turn boundary is what this plugin
 * did before `foldMode` existed (behind `foldAtIdle: true`), and a config that
 * never touched either key must keep that behaviour. `foldAtIdle: false` is the
 * explicit opt-out that predates the mode selector, so it still resolves to `off`.
 * An explicit `foldMode` always wins, because the settings form writes one the
 * moment a human picks a mode.
 */
function resolveFoldMode(raw) {
  const explicit = raw !== null && typeof raw === 'object' ? raw.foldMode : undefined
  if (explicit === 'off' || explicit === 'idle' || explicit === 'handoff') return explicit
  const legacy = raw !== null && typeof raw === 'object' ? raw.foldAtIdle : undefined
  return legacy === false ? 'off' : 'idle'
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
    // Already resolved from `raw`, so a legacy `foldAtIdle: true` and an explicit
    // `foldMode` can never disagree downstream.
    foldMode: resolveFoldMode(raw),
    handoffAt: Math.min(0.95, Math.max(0.5, num(merged.handoffAt, DEFAULT_OPTIONS.handoffAt))),
    handoffDir: typeof merged.handoffDir === 'string' ? merged.handoffDir.trim() : '',
    handoffReminders: Math.max(
      0,
      Math.round(num(merged.handoffReminders, DEFAULT_OPTIONS.handoffReminders)),
    ),
    subagentHandoff: merged.subagentHandoff === true,
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
  // What THIS deployment will actually do — the deadline the model has to plan
  // around. Without it the line named only the host's pressure point even in
  // `handoff` mode, where the actionable deadline is the earlier prep point (a
  // model reading "727K" reasonably concluded the handoff note could wait).
  // `off` renders exactly the old text, so a deployment that wants the host to own
  // folding sees no new instruction.
  const mode = (() => {
    if (!Number.isFinite(reading.threshold) || !Number.isFinite(reading.window)) return ''
    if (options.foldMode === 'handoff') {
      const prep = Math.round(reading.threshold * options.handoffAt)
      const at = Math.round(options.handoffAt * 100)
      return zh
        ? ` 交接式折叠：占用到 ${formatTokens(prep)}（折叠点的 ${at}%）时会提醒你写交接档，折叠在那一轮结束时执行。`
        : ` Handoff folding: at ${formatTokens(prep)} (${at}% of the fold point) you are reminded to write the handoff note; the fold runs at the end of that round.`
    }
    if (options.foldMode === 'idle') {
      const margin = Math.round(reading.window * (options.foldAtIdleMarginPercent / 100))
      return zh
        ? ` 本插件会在你的回合边界主动折叠：余量进入 ${formatTokens(margin)} 以内时执行。`
        : ` This plugin folds at your own turn boundary once the headroom comes within ${formatTokens(margin)}.`
    }
    return ''
  })()
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
        ? `${head0}${free}${point}${mode}${remaining} 上下文不紧张——不要因为"上下文不够"而收尾、交接子代理或缩小范围。${tail}`
        : `${head0}${free}${point}${mode}${remaining} Context is NOT scarce — do not wrap up, hand off to a subagent, or narrow scope for context reasons.${tail}`
    case 'moderate':
      return zh
        ? `${head0}${free}${point}${mode}${remaining} 仍有充足余量，继续推进即可，顺手把关键状态写进文档或提交。${tail}`
        : `${head0}${free}${point}${mode}${remaining} There is still real headroom — keep going, and keep durable notes or commits current as you work.${tail}`
    case 'tight':
      return `${head0}${free}${point}${mode}${remaining}${pace}${fold}${tightClause(zh, options)}${tail}`
    default:
      return zh
        ? `${head0}${free}${point}${mode}${remaining}${pace}${fold} 已到或越过自动压缩点——接下来可能发生压缩折叠，别让关键状态只存在于本窗口。${tail}`
        : `${head0}${free}${point}${mode}${remaining}${pace}${fold} At or past the automatic compaction point — expect earlier turns to be folded; keep nothing critical only in this window.${tail}`
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

  // Handoff prep travels as runtime context, not as a message.
  //
  // A notice published here is rendered by the **next** request's snapshot, not by
  // the one that decided to remind. Measured on 0.2.2 (delegate drill, 2026-11-20):
  // publish at 19:50:08.943, and the block appears in the step whose snapshot is
  // materialized at 19:50:11 — the snapshot is taken before that step's
  // `agent/request` waterfall runs, so the same step cannot carry it. Consequences
  // worth keeping in mind: a round's LAST step can never render a notice (the next
  // round's first step does), and a single-step turn shows it one turn later.
  // `prepare` retires the session's previous notice before deciding anything, so
  // the paragraph is still rendered exactly once rather than on every step.
  const handoffNotices = new Map()

  if (resolve().enabled) {
    try {
      installContextLine(ctx, resolve, services, handoffNotices)
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
  installHandoffFold(ctx, resolve, services, handoffNotices)
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
  // The mode is the authority, not the legacy flag: `resolveOptions` has already
  // mapped `foldAtIdle: true` onto `foldMode: 'idle'`, so a single gate keeps the
  // two spellings from ever disagreeing (`handoff` mode must not also fold here).
  if (options.foldMode !== 'idle') return { fold: false }
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
    if (options.foldMode !== 'idle') return
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
        (outcome) => {
          if (outcome === undefined) {
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
            'context-truth: folded at idle via %s (headroom=%s margin=%s folded=%s)',
            outcome.how,
            decision.headroom,
            decision.margin,
            outcome.folded,
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
 * Unwrap the host's `commands.execute()` answer.
 *
 * `dsh-commands` settles a run as `Object.freeze({ commandId, result })` — a
 * `CommandExecution`, not the `CommandResult` — and the RPC schema is the same two
 * layers. Reading `execution.sourceEventSeq` therefore always misses, and because a
 * missing `sourceEventSeq` is exactly how this plugin recognises "the fold found
 * nothing to compact", **every** successful fold through the command channel looked
 * like a no-op: handoff mode kept the note and never activated the post-fold turn
 * (live: session b28499cb on 2026-11-22 01:22, where `/compact` really folded 1295
 * items / ~506k tokens and `state.json` still said `foldNo: 0`).
 *
 * Both shapes are accepted, so a stub or an older host that answers with the
 * `CommandResult` itself keeps working.
 */
function commandResultOf(execution) {
  if (execution === null || execution === undefined) return undefined
  const nested = execution.result
  return nested !== null && nested !== undefined && typeof nested === 'object' ? nested : execution
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
 * @returns `{ how, folded }` — which channel answered and whether a summary was
 * actually committed — or `undefined` when neither channel could be reached.
 * The two are separate answers on purpose: a `/compact` that finds no compactable
 * range answers successfully without folding, and capability 3 must not activate
 * a follow-up turn on the strength of a fold that never happened.
 */
async function requestFold(ctx, agent, options, services, signal) {
  const session = agent === null || agent === undefined ? undefined : agent.session
  if (options.foldAtIdleMethod !== 'service') {
    const commands = safeGet(ctx, 'commands')
    if (commands !== undefined && typeof commands.execute === 'function') {
      try {
        const execution = await commands.execute(agent, '/compact', [], signal)
        if (execution === undefined) {
          // `execute()` RESOLVES `undefined` — it does not throw — when the line
          // does not parse or the command is not registered in the agent's realm
          // (`dsh-commands`: `if (parsed === void 0) return void 0`). Only a throw
          // used to fall through to the service, so the documented "command, then
          // service" order was dead on a realm without `/compact`.
          if (options.foldAtIdleMethod === 'command') {
            logLine(
              ctx,
              'info',
              'context-truth: /compact is not registered for %s and the fold method is "command"; no other channel is allowed',
              sessionIdOf(session),
            )
            return undefined
          }
          logLine(
            ctx,
            'info',
            'context-truth: /compact is not registered for %s; falling back to the compaction service',
            sessionIdOf(session),
          )
        } else {
          const result = commandResultOf(execution)
          const kind = result === null || result === undefined ? undefined : result.kind
          // `sourceEventSeq` correlates the committed summary with `compaction/summary`
          // and is absent on the "No compactable history yet" success.
          const folded = result !== null && result !== undefined && result.sourceEventSeq !== undefined
          if (!folded && (kind === 'error' || kind === 'cancelled')) {
            logLine(
              ctx,
              'info',
              'context-truth: /compact did not fold for %s (%s): %s',
              sessionIdOf(session),
              kind,
              result.text === undefined ? 'no text' : result.text,
            )
          }
          return { how: 'command', folded, reason: folded ? 'ok' : (kind ?? 'no-range') }
        }
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
  const result = await compaction.compactNow(agent, signal)
  // `null` is the engine's documented "no safe useful range" answer.
  const folded = result !== null && result !== undefined
  return { how: 'service', folded, reason: folded ? 'ok' : 'no-range' }
}

// ---------------------------------------------------------------------------
// Capability 3 (`foldMode: 'handoff'`): fold behind the model's own handoff note.
//
// What `idle` mode leaves on the table is not the fold, it is the surprise. The
// host folds on pressure, between steps, without telling the model; the model then
// rebuilds its picture of a long task from a summary, and the rebuild is where
// repeated work comes from (measured over 143 folds: 81 were followed by the model
// re-reading files it had written itself before the fold).
//
// This mode moves the decision to where the model can still act on it:
//
//   1. PREP     at `handoffAt` × the fold point (default 85%) a reminder is
//               injected into the running turn. The model writes a note to a path
//               this plugin chose, then calls `handoff_ready`.
//   2. FOLD     at that round's end (idle), `compactNow` runs — the same engine
//               `/compact` and the legacy idle fold reach.
//   3. ACTIVATE exactly one follow-up turn whose first instruction is to read the
//               note back before touching the task. One, not a loop: a chain of
//               self-activated turns is how a plugin takes a session over.
//
// Everything here is fail-open. A missing service, an unreadable state file, a
// full disk, an engine that throws — each is logged and leaves the turn alive. The
// worst outcome must be "no fold", never "the session is stuck".
// ---------------------------------------------------------------------------

/** Tool the model calls to register the note it just wrote. */
const HANDOFF_TOOL_NAME = 'handoff_ready'
/** State file kept beside the notes, one per session directory. */
const HANDOFF_STATE_FILE = 'state.json'
/** A note shorter than this cannot carry a task across a fold. */
const HANDOFF_MIN_CHARS = 200
/** Backstop: a note no later cycle referenced again is recycled after a week. */
const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** How often the backstop sweep runs while the plugin is mounted. */
const HANDOFF_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Activation deliveries attempted per fold before giving up (crash recovery). */
const HANDOFF_MAX_ACTIVATION_ATTEMPTS = 2

/** Path segment that cannot escape its directory; session ids are already safe, but never trust that. */
function safeSegment(value) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
  const trimmed = text.slice(0, 120)
  return trimmed === '' ? 'unknown-session' : trimmed
}

/** `$DSH_HOME`, or `~/.dsh` when the host exports nothing. `env` is a parameter so this is testable. */
function dshHome(env) {
  const exported = env !== null && typeof env === 'object' ? env.DSH_HOME : undefined
  if (typeof exported === 'string' && exported.trim() !== '') return exported.trim()
  return join(homedir(), '.dsh')
}

/**
 * Root that owns every session's notes. Empty `handoffDir` means
 * `$DSH_HOME/handoffs`; a relative value resolves under `$DSH_HOME`, so a profile
 * patch can say `handoffs-test` without hard-coding an absolute path.
 */
function handoffRoot(options, env) {
  const configured = typeof options.handoffDir === 'string' ? options.handoffDir.trim() : ''
  const home = dshHome(env === undefined ? process.env : env)
  if (configured === '') return join(home, 'handoffs')
  return isAbsolute(configured) ? configured : resolvePath(home, configured)
}

/** `<root>/<sessionId>/<fold#>.handoff.md` — one directory per session, never the workspace. */
function handoffPathFor(root, sessionId, foldNo) {
  const label = String(Math.max(1, Math.round(Number.isFinite(foldNo) ? foldNo : 1))).padStart(3, '0')
  return join(root, safeSegment(sessionId), `${label}.handoff.md`)
}

/** Session identity, header first: that is the id the store and the UI use. */
function sessionIdOf(session) {
  if (session === null || session === undefined) return ''
  const header = session.header
  const candidates = [header === null || header === undefined ? undefined : header.id, session.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * Whether this session is a delegate of another one.
 *
 * Measured on this host: the session header carries no `origin` field, so
 * `delegationDepth` is the authoritative signal — 0 for a root session, > 0 for
 * anything a delegation created. Folding a delegate would activate a turn nobody
 * is watching, so handoff mode stays out of those sessions entirely.
 */
function isDelegate(session) {
  const header = session === null || session === undefined ? undefined : session.header
  const depth = header === null || header === undefined ? undefined : header.delegationDepth
  return Number.isFinite(depth) && depth > 0
}

/** The prep point: `handoffAt` of the FOLD POINT, plus the numbers behind the decision. */
function handoffTrigger(reading, options) {
  if (options.foldMode !== 'handoff') return { prepare: false }
  const used = reading === null || reading === undefined ? undefined : reading.used
  const threshold = reading === null || reading === undefined ? undefined : reading.threshold
  if (!Number.isFinite(used) || !Number.isFinite(threshold) || threshold <= 0) return { prepare: false }
  const ratio = Math.min(0.95, Math.max(0.5, num(options.handoffAt, DEFAULT_OPTIONS.handoffAt)))
  const point = Math.round(threshold * ratio)
  return { prepare: used >= point, point, used, threshold, headroom: Math.round(threshold - used) }
}

/** The reading as a percentage of the fold point, for message text. */
function foldPointPercent(used, threshold) {
  if (!Number.isFinite(used) || !Number.isFinite(threshold) || threshold <= 0) return '?'
  return String(Math.round((used / threshold) * 100))
}

/** Same file, however it was spelled. Windows compares case-insensitively. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === '' || right === '') return false
  try {
    const a = resolvePath(left)
    const b = resolvePath(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/** The message shape the agent loop accepts from a plugin (`followup` / `inject`). */
function handoffMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** Prep reminder: what to write, exactly where, and why it is worth the steps. */
function handoffPrepMessage({ path, trigger, recycled, options }) {
  const percent = foldPointPercent(trigger.used, trigger.threshold)
  const used = formatTokens(trigger.used)
  const point = formatTokens(trigger.threshold)
  const recycledNote =
    recycled > 0
      ? options.language === 'zh'
        ? `（按回收策略删掉了上一份 ${recycled} 个档文件。）`
        : ` (recycled ${recycled} older note file(s) per the recycling rule.)`
      : ''
  if (options.language === 'zh') {
    return [
      `[交接式折叠 · 准备] 本会话已用到折叠点的 ${percent}%（${used} / ${point}）。宿主的自动折叠会在折叠点直接发生，不看你的进度；折叠后你只能靠摘要重建认知，长任务里那正是重复劳动的来源。`,
      '',
      '现在写一份交接档给折叠后的你自己，然后继续手头的活（不要为写档中断任务）：',
      `1) 路径必须是这个，不要改：${path}`,
      '2) 按这几节写，标准是「不看对话历史也能立刻接上」：',
      '   - 当前目标（一句话）',
      '   - 已定案（拍过板的决定，注明勿再复议）',
      '   - 已验证的事实与证据（命令输出、file:line）',
      '   - 待办（按序，标出下一步的第一个动作）',
      '   - 关键路径',
      '   - 坑（试过并失败的路线，避免重试）',
      '3) 写完调用工具 handoff_ready 登记（它只认上面这个路径）。',
      `4) 这是临时文件：下一次交接生成时它会被回收${recycledNote}。要长期保留的内容写进项目里，不要留在这里。`,
      '',
      '本轮结束时才会折叠，之后会自动开一轮（仅一轮）让你读档接着做。',
    ].join('\n')
  }
  return [
    `[handoff fold · prepare] This session is at ${percent}% of its fold point (${used} / ${point}). The host's automatic fold happens at the fold point regardless of where you are in your work; after it you would rebuild your picture from a summary, which is where long tasks pay for repeated work.`,
    '',
    'Write a handoff note for the post-fold you, then continue your work (do not interrupt the task to do this):',
    `1) The path must be exactly this one, do not change it: ${path}`,
    '2) Use these sections; the bar is "a reader with no conversation history can continue":',
    '   - current goal (one line)',
    '   - decisions already made (note that they are settled)',
    '   - verified facts and their evidence (command output, file:line)',
    '   - next steps in order, with the very next action marked',
    '   - key paths',
    '   - dead ends already tried, so they are not retried',
    '3) Then call the handoff_ready tool to register it; it only accepts the path above.',
    `4) This is a temporary file: it is recycled when the next handoff is created${recycledNote}. Anything that must outlive it belongs in the project.`,
    '',
    'The fold runs at the end of this round, and exactly one follow-up turn is activated to read the note back.',
  ].join('\n')
}

/**
 * Delegate variant of the prep reminder.
 *
 * Two things must NOT be copied from the root text: `handoff_ready` (a child's
 * call is refused on purpose, and telling it to call a refusing tool is worse than
 * saying nothing) and the promise that the fold runs at this round's end (nothing
 * here folds a delegate; the host does it at the pressure point, whenever that
 * lands). What survives is the part that matters: the one allowed path, the
 * section checklist, and the bar — a reader with no conversation history.
 */
function handoffDelegatePrepMessage({ path, trigger, recycled, options }) {
  const percent = foldPointPercent(trigger.used, trigger.threshold)
  const used = formatTokens(trigger.used)
  const point = formatTokens(trigger.threshold)
  const recycledNote =
    recycled > 0
      ? options.language === 'zh'
        ? `（按回收策略删掉了上一份 ${recycled} 个档文件。）`
        : ` (recycled ${recycled} older note file(s) per the recycling rule.)`
      : ''
  if (options.language === 'zh') {
    return [
      `[交接式折叠 · 子代理准备] 这个被委派的会话已用到折叠点的 ${percent}%（${used} / ${point}）。折叠由宿主在折叠点执行，不看你的进度；它不是本插件的折叠，也不会给你开新轮。`,
      '',
      '现在写一份交接档给折叠后的你自己，然后继续手头的活（不要为写档中断任务）：',
      `1) 路径必须是这个，不要改：${path}`,
      '2) 按这几节写，标准是「不看对话历史也能立刻接上」：',
      '   - 当前目标（一句话）',
      '   - 已定案（拍过板的决定，注明勿再复议）',
      '   - 已验证的事实与证据（命令输出、file:line）',
      '   - 待办（按序，标出下一步的第一个动作）',
      '   - 关键路径',
      '   - 坑（试过并失败的路线，避免重试）',
      '3) 写完就够了，不要调用工具登记：**文件本身就是登记**（`handoff_ready` 对子代理一律拒答）。',
      `4) 这是临时文件：下一次交接生成时它会被回收${recycledNote}。要长期保留的内容写进项目里，不要留在这里。`,
      '',
      '折叠之后，你下一次被唤醒的那个请求里会把这份档的路径再指给你一次。',
    ].join('\n')
  }
  return [
    `[handoff fold · subagent prepare] This delegated session is at ${percent}% of its fold point (${used} / ${point}). The fold is the host's, at the fold point, regardless of where you are in your work; it is not this plugin's fold and it will not open a turn for you.`,
    '',
    'Write a handoff note for the post-fold you, then continue your work (do not interrupt the task to do this):',
    `1) The path must be exactly this one, do not change it: ${path}`,
    '2) Use these sections; the bar is "a reader with no conversation history can continue":',
    '   - current goal (one line)',
    '   - decisions already made (note that they are settled)',
    '   - verified facts and their evidence (command output, file:line)',
    '   - next steps in order, with the very next action marked',
    '   - key paths',
    '   - dead ends already tried, so they are not retried',
    '3) Writing the file is the whole registration; do not call a tool for it (`handoff_ready` refuses a delegated session on purpose).',
    `4) This is a temporary file: it is recycled when the next handoff is created${recycledNote}. Anything that must outlive it belongs in the project.`,
    '',
    'After the fold, the next request you serve will point you back at this note.',
  ].join('\n')
}

/**
 * Delegate variant of the activation turn: a pointer, not a turn.
 *
 * A delegate cannot be woken without breaking whoever is driving it, so the
 * post-fold step is a runtime-context block on the request the parent causes
 * next. It therefore has to carry the "read it first" instruction itself — there
 * is no first user message of an activation round to lean on.
 */
function handoffDelegateFoldMessage({ path, options }) {
  if (options.language === 'zh') {
    return [
      '[交接式折叠 · 子代理折叠后] 你的窗口在上一次请求之后被折叠过了：细节已经不在上下文里，摘要是有损重建。',
      '折叠前你自己写过一份交接档，它还在 —— 先读它再动手：',
      path,
      '',
      '1) 先 read 这个文件。它比摘要可靠：那里是你折叠前的第一手记录。',
      '2) 从它的「待办」继续，不要重新推导档里已经写明的结论。',
      '3) 如果档里的描述和你现在看到的实际情况冲突，以实际情况为准，并在给委派方的汇报里说清分歧。',
    ].join('\n')
  }
  return [
    '[handoff fold · subagent, after the fold] Your window was folded since your last request: the details are no longer in context and the summary is a lossy reconstruction.',
    'You wrote yourself a handoff note before that happened, and it is still there — read it before you act:',
    path,
    '',
    '1) Read that file first. It is your own first-hand record from before the fold, and it is more reliable than the summary.',
    '2) Continue from its "next steps"; do not re-derive conclusions it already states.',
    '3) Where it disagrees with what you observe now, trust the observation and say where they diverged when you report back.',
  ].join('\n')
}

/**
 * Wake message: one line that opens the round.
 *
 * The full reminder travels as the `context-truth:handoff` runtime-context block
 * of that same round (`prepare` publishes it), because a message that starts a
 * turn is also the only thing the model is guaranteed to read before the
 * request. The path is repeated here so the message stays actionable even if the
 * block cannot render (for example a fold-mode change in between).
 */
function handoffWakeMessage({ path, options }) {
  if (options.language === 'zh') {
    return [
      '[交接式折叠 · 唤醒] 本轮结束时会折叠，所以现在补一份交接档。',
      `完整提醒（唯一允许的路径与分节清单）在 runtime context 的 handoff 块里；路径必须是：${path}`,
    ].join('\n')
  }
  return [
    '[handoff fold · wake] This round is folded when it ends, so write the handoff note now.',
    `The full reminder (the one allowed path and the section checklist) is in the handoff runtime-context block; the path must be exactly: ${path}`,
  ].join('\n')
}

/**
 * Activation body: read the note first, then finish the interrupted work.
 *
 * This travels as a runtime-context block (`context-truth:handoff`), not as the
 * message that opens the turn. Reason: the fold runs at a round's end, and the next
 * round may be opened by something else — a goal continuation (`source.kind:
 * "goal"`) or another session's `session_call`. Measured 2026-11-24 in session
 * c5d0874b: the fold ended at 23:16:04, a goal round started in the same second,
 * and the `followup` carrying this text only landed at 23:17:22 — 78 s later,
 * inside that already-running round, where it read as a footnote to the objective.
 * A notice in this channel is rendered by the NEXT request's snapshot whichever
 * round it belongs to, so it is in front of the model on the first step of that
 * round instead of queueing behind it.
 */
function handoffActivationMessage({ path, foldNo, options }) {
  if (options.language === 'zh') {
    return [
      `[交接式折叠 · 激活] 你上一轮被折叠了（本会话第 ${foldNo} 次）。折叠前你自己写了交接档：`,
      path,
      '',
      '如果这一轮不是你打开的（例如目标续跑，或另一个会话发来的消息），顺序不变：先读档，再执行那些指令。',
      '这是唯一一次自动激活的轮次，不会连续自动开轮。按顺序做：',
      '1) 先 read 这个文件，再动手。它是你对折叠前状态的第一手记录，比摘要可靠。',
      '2) 按「待办」继续，把因折叠被打断的那件事做完。不要重新推导档里已经写明的结论——省掉那段时间正是这套机制的目的。',
      '3) 这一轮内文件还在：你记得、但档里没写的关键事实，补进去。',
      '4) 如果档里的描述和你现在看到的实际情况冲突，以实际情况为准，并在最后说明冲突在哪。',
      '5) 结束时简短交代：从档里接上了什么、这一轮推进了什么。',
    ].join('\n')
  }
  return [
    `[handoff fold · activate] Your previous round was folded (fold #${foldNo} of this session). Before it happened you wrote yourself a handoff note:`,
    path,
    '',
    'If this round was opened by something else (a goal continuation, another session\'s message), the order is unchanged: read the note first, then follow those instructions.',
    'This is the only auto-activated turn; nothing will auto-activate again until the next fold. In order:',
    '1) Read that file first, before doing anything else. It is your own first-hand record of the state, more reliable than the summary.',
    '2) Continue from its "next steps" and finish what the fold interrupted. Do not re-derive conclusions the note already states — not paying that cost is the point of this mechanism.',
    '3) The file still exists this round: add any key fact you remember that it is missing.',
    '4) Where the note disagrees with what you observe now, trust the observation and say where they diverged.',
    '5) End with a short account of what you picked up from the note and what this round advanced.',
  ].join('\n')
}

/**
 * Activation wake: one line whose only job is to open a round when nobody else does.
 *
 * The body above rides runtime context; this message exists because a session that
 * is genuinely idle produces no request, and without one the block is never
 * rendered. When another driver (goal round, `session_call`) opens the round first,
 * this line simply queues behind it and the block has already done its work.
 */
function handoffActivationWakeMessage({ path, foldNo, options }) {
  if (options.language === 'zh') {
    return [
      `[交接式折叠 · 唤醒] 折叠完成（本会话第 ${foldNo} 次）：先读交接档，再继续。`,
      `路径必须是：${path}`,
      '完整说明在本轮 runtime context 的 handoff 块里；这是唯一一次自动激活。',
    ].join('\n')
  }
  return [
    `[handoff fold · wake] Folded (fold #${foldNo} of this session): read the handoff note before continuing.`,
    `The path must be exactly: ${path}`,
    'The full instruction is in this round\'s handoff runtime-context block; this is the only auto-activated turn.',
  ].join('\n')
}

/** A fresh state record for one session. */
function emptyHandoffState(sessionId) {
  return { version: 1, sessionId, foldNo: 0, reminders: 0, reminderTurn: null, ready: null, pending: null, wokenAt: null }
}

/**
 * A registered note, or `null` when the record is unusable.
 *
 * `used` is the occupancy at the moment the note was seen. The root path writes it
 * for the record and never reads it; the delegate path reads it to tell a real fold
 * (the reading halves) from a small trim (the reading wobbles), because a delegate's
 * fold is somebody else's decision and cannot be inferred from a fold count.
 */
function normalizeReady(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.path !== 'string' || value.path === '') return null
  return {
    path: value.path,
    chars: Number.isFinite(value.chars) ? value.chars : 0,
    at: Number.isFinite(value.at) ? value.at : 0,
    used: Number.isFinite(value.used) && value.used > 0 ? value.used : 0,
  }
}

/** A queued activation, or `null`. */
function normalizePending(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.path !== 'string' || value.path === '') return null
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : randomUUID(),
    path: value.path,
    foldNo: Number.isFinite(value.foldNo) ? Math.round(value.foldNo) : 0,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
    attempts: Number.isFinite(value.attempts) && value.attempts >= 0 ? Math.round(value.attempts) : 0,
    deliveredAt: Number.isFinite(value.deliveredAt) ? value.deliveredAt : null,
  }
}

/**
 * Load one session's state, or a fresh record.
 *
 * Synchronous on purpose: the prep decision runs inside the `agent/request`
 * waterfall, where an await would delay the model call, and this is a few hundred
 * bytes read at most once per turn. A corrupt or unreadable file degrades to "no
 * state" instead of throwing — the worst case is one duplicate reminder, not a
 * broken session.
 */
function readHandoffState(dir, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, HANDOFF_STATE_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyHandoffState(sessionId)
    const state = emptyHandoffState(sessionId)
    if (Number.isFinite(parsed.foldNo) && parsed.foldNo >= 0) state.foldNo = Math.round(parsed.foldNo)
    if (Number.isFinite(parsed.reminders) && parsed.reminders >= 0) state.reminders = Math.round(parsed.reminders)
    if (Number.isFinite(parsed.reminderTurn)) state.reminderTurn = Math.round(parsed.reminderTurn)
    if (Number.isFinite(parsed.wokenAt)) state.wokenAt = Math.round(parsed.wokenAt)
    state.ready = normalizeReady(parsed.ready)
    state.pending = normalizePending(parsed.pending)
    return state
  } catch {
    return emptyHandoffState(sessionId)
  }
}

/** Mirror one session's state to disk. Returns whether it landed. */
function writeHandoffState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, HANDOFF_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Character count of a note, or `null` when the file is missing or not a file. */
function handoffFileChars(path) {
  try {
    if (!statSync(path).isFile()) return null
    return readFileSync(path, 'utf8').length
  } catch {
    return null
  }
}

/**
 * Notes this prep should recycle: everything in the session directory except the
 * paths it must survive and the state file.
 *
 * Decision: recycling happens when the NEXT handoff is handed out, and the next
 * note's number is always `foldNo + 1`, so the ONLY note that must survive is the
 * one the last fold activated — `foldNo`'s own note. Keeping it is not a nicety:
 * the prep for note N+1 runs at the head of the activation turn for note N, so a
 * recycle that ignored this deleted the activation target 4.5s after it was
 * activated and the turn's first `read` failed with FS_NOT_FOUND (live drill,
 * 2026-11-16: activated 18:39:58.877, prep 18:40:03.431, read 18:40:04.983).
 * The older reasoning — "an undelivered activation is protected upstream" — ✗ was
 * wrong, because delivery happens before the round starts, not after it ends.
 */
function handoffReapable(root, sessionId, keepPaths) {
  const dir = join(root, safeSegment(sessionId))
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const keep = Array.isArray(keepPaths) ? keepPaths : [keepPaths]
  const doomed = []
  for (const entry of names) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const full = join(dir, entry)
    if (keep.some((keepPath) => samePath(full, keepPath))) continue
    doomed.push(full)
  }
  return doomed
}

/** Delete files, tolerating a locked one (it is swept next pass). */
function deleteFiles(files) {
  let removed = 0
  for (const file of files) {
    try {
      unlinkSync(file)
      removed += 1
    } catch {
      // A locked or already-gone file is not an error worth failing a prep for.
    }
  }
  return removed
}

/**
 * Backstop sweep: notes older than `maxAgeMs` go, then directories left holding
 * nothing but their state file. A directory with an undelivered activation is left
 * alone — its note is about to be read.
 */
function sweepHandoffs(root, nowMs, maxAgeMs) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry === null || entry === undefined || !entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const state = readHandoffState(dir, entry.name)
    const spare = state.pending !== null && state.pending.deliveredAt === null ? state.pending.path : null
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md')) continue
      const file = join(dir, name)
      if (spare !== null && samePath(file, spare)) continue
      let info
      try {
        info = statSync(file)
      } catch {
        continue
      }
      if (nowMs - info.mtimeMs <= maxAgeMs) continue
      try {
        unlinkSync(file)
        removed += 1
      } catch {
        // Swept next time.
      }
    }
    try {
      const left = readdirSync(dir).filter((name) => name !== HANDOFF_STATE_FILE)
      // Pruning takes the state file with the directory, so it must be as
      // conservative as the note sweep: only when nothing but the state remains
      // AND the state itself has not been touched for the same week. Getting this
      // wrong is not cosmetic — the sweep runs at every plugin load, and the state
      // it would have deleted is exactly the pending activation that restart
      // recovery depends on (found by a unit test that lost its fixture).
      let stateStale = true
      try {
        stateStale = nowMs - statSync(join(dir, HANDOFF_STATE_FILE)).mtimeMs > maxAgeMs
      } catch {
        stateStale = true
      }
      if (left.length === 0 && stateStale) rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory that cannot be pruned now is pruned later.
    }
  }
  return removed
}

/**
 * Install the handoff fold: prep reminder, `handoff_ready`, the round-end fold, the
 * single activation turn, and the recycling that keeps the directory bounded.
 *
 * `notices` is the runtime-context delivery channel shared with `installContextLine`:
 * the prep reminder is published there instead of being queued as a user message.
 */
function installHandoffFold(ctx, resolve, services, notices) {
  /** Per-session state, hydrated from disk on first use and mirrored back on change. */
  const states = new Map()
  /** One-shot log keys: a condition that recurs every step is reported once. */
  const noted = new Set()
  /** A fold is an engine call; never run two at once from this closure. */
  let folding = false

  const dirFor = (options, sessionId) => join(handoffRoot(options), safeSegment(sessionId))

  const messageOf = (error) =>
    error === null || error === undefined ? 'unknown error' : (error.message ?? String(error))

  function noteOnce(key, level, format, ...args) {
    if (noted.has(key)) return
    noted.add(key)
    logLine(ctx, level, format, ...args)
  }

  function stateFor(options, sessionId) {
    const cached = states.get(sessionId)
    if (cached !== undefined) return cached
    const loaded = readHandoffState(dirFor(options, sessionId), sessionId)
    states.set(sessionId, loaded)
    return loaded
  }

  function persist(options, sessionId, state) {
    if (writeHandoffState(dirFor(options, sessionId), state)) return
    noteOnce(
      `state-write:${sessionId}`,
      'warn',
      'context-truth: could not write the handoff state for %s; this fold still works, restart recovery will not',
      sessionId,
    )
  }

  /**
   * Publish the full prep reminder for the request that is being assembled.
   *
   * Both delivery paths share it: the mid-round trigger below, and the wake round
   * (whose message is only a one-liner, so the checklist has to ride runtime
   * context). Returns the published payload, or `null` when the reading is no
   * longer past the prep point — the wake round then keeps just its one-line
   * message instead of nagging about a fold that is no longer due.
   */
  function publishPrep(state, options, sessionId, session) {
    const trigger = handoffTrigger(readOccupancy(ctx, session, options, services.meter), options)
    if (!trigger.prepare) {
      logLine(
        ctx,
        'info',
        'context-truth: wake round for %s is below the prep point now (used=%s of %s); the one-line wake stands alone',
        sessionId,
        trigger.used,
        trigger.threshold,
      )
      return null
    }
    const root = handoffRoot(options)
    const path = handoffPathFor(root, sessionId, state.foldNo + 1)
    const doomed = handoffReapable(root, sessionId, [path, handoffPathFor(root, sessionId, state.foldNo)])
    notices.set(sessionId, handoffPrepMessage({ path, trigger, recycled: doomed.length, options }))
    // Same ordering as the mid-round path: publish first, reap after, so a failed
    // delivery never costs the model its previous note for nothing.
    const recycled = deleteFiles(doomed)
    logLine(
      ctx,
      'info',
      'context-truth: wake round for %s published the handoff reminder in runtime context (used=%s of %s, recycled=%s) -> %s',
      sessionId,
      trigger.used,
      trigger.threshold,
      recycled,
      path,
    )
    return { path, trigger, recycled }
  }

  /**
   * Step 1c: the delegate variant of step 1 (`subagentHandoff`, opt-in).
   *
   * A delegated session has the same blind spot as a root one — the fold rewrites
   * the window and the first-hand record of what it was doing goes with it — but
   * none of the same levers: nothing here may fold it (the host owns that) and
   * nothing here may wake it (its parent owns its turns). So the variant is
   * exactly: remind, take the FILE as the registration, and after the fold hand
   * back the way to that note.
   *
   * The fold is detected from the reading, not from a fold counter: `used` only
   * drops when somebody rewrote the window, so a registered note plus a reading
   * below 90% of the reading it was registered at IS the fold. Anything gentler is
   * a trim (a tool catalog coming and going, `defer_loading`) and is ignored. The
   * 10% band is what keeps a 2K wobble from being reported as a fold.
   */
  function prepareDelegate(options, session, turn) {
    const sessionId = sessionIdOf(session)
    if (sessionId === '') return
    // Same one-shot discipline as the root path: retire the previous request's
    // block before this request decides anything.
    notices.delete(sessionId)
    const state = stateFor(options, sessionId)
    const root = handoffRoot(options)
    const path = handoffPathFor(root, sessionId, state.foldNo + 1)
    const trigger = handoffTrigger(readOccupancy(ctx, session, options, services.meter), options)

    // Discovery. A child never gets `handoff_ready` (the tool refuses delegates on
    // purpose), so requiring a registration call would make every reminder a dead
    // end: the file the model wrote is the registration.
    const chars = handoffFileChars(path)
    if (chars !== null && state.ready === null) {
      state.ready = {
        path,
        chars,
        at: Date.now(),
        used: Number.isFinite(trigger.used) && trigger.used > 0 ? trigger.used : 0,
      }
      persist(options, sessionId, state)
      logLine(ctx, 'info', 'context-truth: delegate %s wrote its handoff note (%s chars) -> %s', sessionId, chars, path)
    }

    if (state.ready !== null && Number.isFinite(trigger.used)) {
      const note = state.ready
      const folded = note.used > 0 && trigger.used < note.used * 0.9
      // A note found while already below the prep point was written before this
      // plugin started watching (a restart, or the option switched on mid-session),
      // so the fold it was written for has already happened.
      const discoveredLate = note.used === 0 && !trigger.prepare
      if (folded || discoveredLate) {
        state.foldNo += 1
        state.ready = null
        state.reminders = 0
        state.reminderTurn = turn === undefined ? null : turn
        persist(options, sessionId, state)
        notices.set(sessionId, handoffDelegateFoldMessage({ path: note.path, options }))
        logLine(
          ctx,
          'info',
          'context-truth: delegate %s was folded since it wrote %s (used=%s, registered at=%s, cause=%s); pointing it back',
          sessionId,
          note.path,
          trigger.used,
          note.used > 0 ? note.used : 'unknown',
          folded ? 'reading dropped' : 'note found below the prep point',
        )
        return
      }
    }

    if (!trigger.prepare) return
    // A pending note owns the next reminder; nagging on top of it only costs turns.
    if (state.ready !== null) return
    if (state.reminders >= options.handoffReminders) {
      noteOnce(
        `delegate-budget:${sessionId}`,
        'info',
        'context-truth: delegate handoff reminder budget spent for %s (%s in this cycle); the host pressure fold takes this one',
        sessionId,
        options.handoffReminders,
      )
      return
    }
    if (turn !== undefined && state.reminderTurn === turn) return
    const doomed = handoffReapable(root, sessionId, [path, handoffPathFor(root, sessionId, state.foldNo)])
    // Runtime context, exactly like the root reminder, and with the same one-step
    // delay: this request's snapshot is already materialized, so the child reads it
    // on its next step (or next turn, if this was its last step). No user message
    // is fabricated on the parent's behalf.
    notices.set(sessionId, handoffDelegatePrepMessage({ path, trigger, recycled: doomed.length, options }))
    // Reap after the notice lands, so a failed delivery never costs the previous note.
    const recycled = deleteFiles(doomed)
    state.reminders += 1
    state.reminderTurn = turn === undefined ? null : turn
    persist(options, sessionId, state)
    logLine(
      ctx,
      'info',
      'context-truth: delegate handoff prep %s/%s for %s (used=%s of the %s fold point, recycled=%s) -> %s',
      state.reminders,
      options.handoffReminders,
      sessionId,
      trigger.used,
      trigger.threshold,
      recycled,
      path,
    )
  }

  /**
   * Step 1: remind the model while it can still act. Runs inside the
   * `agent/request` waterfall, so it stays synchronous and swallows everything —
   * the return value is the model call's configuration.
   */
  function prepare(agent, turn) {
    const options = resolve()
    // The tool catalog follows the mode even for a session this scope does not
    // remind (a delegate, an unnamed session): `off`/`idle` must never advertise a
    // tool the mode cannot honour.
    syncHandoffTool(options)
    if (options.foldMode !== 'handoff') return
    const session = agent === null || agent === undefined ? undefined : agent.session
    if (session === null || session === undefined) return
    if (isDelegate(session)) {
      // Reduced variant (opt-in): remind and point back, never wake and never fold.
      if (options.subagentHandoff) prepareDelegate(options, session, turn)
      return
    }
    const sessionId = sessionIdOf(session)
    if (sessionId === '') return
    // Retire the previous request's notice before this request decides anything,
    // so the paragraph is rendered exactly once (see `handoffNotices` in `apply`).
    notices.delete(sessionId)
    const state = stateFor(options, sessionId)
    // A wake already carries this round's reminder as its first user message; a
    // second inject would stack two copies of it in the same round.
    if (state.wokenAt !== null) {
      state.wokenAt = null
      // 唤醒轮的第一条消息就是提醒，把它记成“本轮已提醒”，否则同一轮第二个
      // request 会再注入一条（实机 01:39:07 唤醒 2/3，01:39:17 又注入 3/3）。
      state.reminderTurn = turn === undefined ? null : turn
      // 唤醒消息只是一行入口；完整提醒在这里重新发布，由**本请求**的
      // runtime-context 块渲染（`context-truth:handoff`）。唤醒轮一定有请求，
      // 所以这条通道在这里是可用的 —— 这也是 A 方案能消掉“整段提醒变成用户
      // 消息”的原因。✗ 不要在这里提前 return，否则本轮只剩那一行短消息。
      publishPrep(state, options, sessionId, session)
      persist(options, sessionId, state)
      return
    }
    // A queued activation owns the next round: never remind on top of it.
    if (state.pending !== null && state.pending.deliveredAt === null) return
    if (state.ready !== null) return
    if (state.reminders >= options.handoffReminders) {
      noteOnce(
        `budget:${sessionId}`,
        'info',
        'context-truth: handoff reminder budget spent for %s (%s in this cycle); the host pressure fold takes this one',
        sessionId,
        options.handoffReminders,
      )
      return
    }
    if (turn !== undefined && state.reminderTurn === turn) return
    const reading = readOccupancy(ctx, session, options, services.meter)
    const trigger = handoffTrigger(reading, options)
    if (!trigger.prepare) return

    const root = handoffRoot(options)
    const path = handoffPathFor(root, sessionId, state.foldNo + 1)
    // 交接档 N 是当前折叠的激活目标，必须活到激活轮读完它；准备轮 N+1 就发生在激活轮
    // 里，所以这里按编号把它排除掉（✗ 旧实现只排除“未投递的激活”，而投递发生在轮次开始
    // 之前，等于没排除）。不额外按 pending.path 排除：一次折叠后 pending.foldNo 恒等于
    // state.foldNo，两者指向同一份文件 —— 两套守卫互为冗余时，变异测试抓不住任何一套
    // （实测：删掉编号守卫，67/67 仍全绿，因为 pending 守卫替它挡了）。
    const keep = [path, handoffPathFor(root, sessionId, state.foldNo)]
    const doomed = handoffReapable(root, sessionId, keep)
    // Publish the reminder into runtime context instead of queueing a user
    // message: it is as timely as `inject` and never looks like something the human
    // typed. It is rendered by the NEXT request's snapshot (see the note above
    // `handoffNotices`), which for a multi-step round is one step away.
    notices.set(sessionId, handoffPrepMessage({ path, trigger, recycled: doomed.length, options }))
    // Reap after the notice lands, so a failed delivery does not cost the model
    // its previous note for nothing.
    const recycled = deleteFiles(doomed)
    state.reminders += 1
    state.reminderTurn = turn === undefined ? null : turn
    persist(options, sessionId, state)
    logLine(
      ctx,
      'info',
      'context-truth: handoff prep %s/%s for %s (used=%s of the %s fold point, recycled=%s) -> %s',
      state.reminders,
      options.handoffReminders,
      sessionId,
      trigger.used,
      trigger.threshold,
      recycled,
      path,
    )
  }

  /**
   * Step 1b: wake a round with the reminder.
   *
   * `agent.inject` only queues for the next REQUEST of a running round. When the
   * reminder trips on the model's last step of a round, the message waits for
   * something to start a new round — observed live: injected 18:48:04.482, read
   * only after the human's next message. A round end is the one moment a wake is
   * both safe (nothing is running) and bounded (the same reminder budget).
   */
  function remind(agent, options, sessionId, state) {
    if (state.wokenAt !== null) return
    const trigger = handoffTrigger(readOccupancy(ctx, agent.session, options, services.meter), options)
    if (!trigger.prepare) {
      noteOnce(
        `no-note:${sessionId}`,
        'info',
        'context-truth: %s ended a round without handoff_ready and below the prep point; leaving this fold to the host pressure trigger',
        sessionId,
      )
      return
    }
    if (state.reminders >= options.handoffReminders) {
      noteOnce(
        `budget:${sessionId}`,
        'info',
        'context-truth: handoff reminder budget spent for %s (%s in this cycle); leaving this fold to the host pressure trigger',
        sessionId,
        options.handoffReminders,
      )
      return
    }
    const root = handoffRoot(options)
    const path = handoffPathFor(root, sessionId, state.foldNo + 1)
    const doomed = handoffReapable(root, sessionId, [path, handoffPathFor(root, sessionId, state.foldNo)])
    try {
      // Short on purpose: the wake message only opens the round. The full
      // reminder is published into runtime context by `prepare` on that round's
      // first request, so the transcript shows a one-liner instead of the whole
      // checklist (see `handoffWakeMessage`).
      agent.followup(handoffMessage(handoffWakeMessage({ path, options })))
    } catch (error) {
      logLine(ctx, 'warn', 'context-truth: could not wake %s with the handoff reminder: %s', sessionId, messageOf(error))
      return
    }
    const recycled = deleteFiles(doomed)
    state.reminders += 1
    state.wokenAt = Date.now()
    state.reminderTurn = null
    persist(options, sessionId, state)
    logLine(
      ctx,
      'info',
      'context-truth: handoff reminder %s/%s for %s woke the round (used=%s of the %s fold point, recycled=%s) -> %s',
      state.reminders,
      options.handoffReminders,
      sessionId,
      trigger.used,
      trigger.threshold,
      recycled,
      path,
    )
  }

  /** Step 3: deliver the one activation turn, at most twice across restarts. */
  function deliver(agent, options, sessionId, state) {
    const pending = state.pending
    if (pending === null || pending.deliveredAt !== null) return
    if (pending.attempts >= HANDOFF_MAX_ACTIVATION_ATTEMPTS) {
      logLine(
        ctx,
        'warn',
        'context-truth: activation for fold #%s of %s failed %s times; leaving the session to the human (note: %s)',
        pending.foldNo,
        sessionId,
        pending.attempts,
        pending.path,
      )
      return
    }
    // The activation message names a file; a turn whose first step is a read of a
    // missing file is worse than no activation at all. The recycle rule below no
    // longer deletes this note, so this is the backstop for the other ways it can
    // vanish (a human, a sweep, another instance).
    try {
      if (!statSync(pending.path).isFile()) throw new Error('not a regular file')
    } catch (error) {
      logLine(
        ctx,
        'warn',
        'context-truth: the note for fold #%s of %s is gone (%s); releasing the activation instead of pointing a turn at a missing file',
        pending.foldNo,
        sessionId,
        messageOf(error),
      )
      state.pending = null
      persist(options, sessionId, state)
      return
    }
    // Publish the block BEFORE the wake. Whichever request comes next — ours, or
    // one a goal continuation / another session opened — renders it on its first
    // step. The wake is only there so a genuinely idle session produces that
    // request at all (see `handoffActivationWakeMessage`).
    notices.set(sessionId, handoffActivationMessage({ path: pending.path, foldNo: pending.foldNo, options }))
    // Persist the attempt BEFORE sending. A crash between the two can duplicate one
    // message at worst (bounded by the cap above); it can never loop.
    pending.attempts += 1
    persist(options, sessionId, state)
    try {
      agent.followup(
        handoffMessage(handoffActivationWakeMessage({ path: pending.path, foldNo: pending.foldNo, options })),
      )
    } catch (error) {
      logLine(ctx, 'warn', 'context-truth: could not activate the post-fold turn for %s: %s', sessionId, messageOf(error))
      return
    }
    pending.deliveredAt = Date.now()
    persist(options, sessionId, state)
    logLine(ctx, 'info', 'context-truth: activated fold #%s of %s -> %s', pending.foldNo, sessionId, pending.path)
  }

  /** Step 2: at the round's end, fold if the model registered a note. */
  function foldAtRoundEnd(agent) {
    const options = resolve()
    if (options.foldMode !== 'handoff') return
    const session = agent === null || agent === undefined ? undefined : agent.session
    if (session === null || session === undefined) return
    if (isDelegate(session)) return
    const sessionId = sessionIdOf(session)
    if (sessionId === '') return
    const state = stateFor(options, sessionId)

    // An activation that never left the building comes first: the fold already
    // happened, and the missing piece is the round that was supposed to read it.
    if (state.pending !== null && state.pending.deliveredAt === null) {
      deliver(agent, options, sessionId, state)
      return
    }
    if (state.ready === null) {
      remind(agent, options, sessionId, state)
      return
    }
    if (folding) return
    const reading = readOccupancy(ctx, session, options, services.meter)
    const trigger = handoffTrigger(reading, options)
    if (!trigger.prepare) {
      // A reading far below the prep point means somebody else folded first (the
      // host at pressure, or a human running /compact). The note was not used.
      const foldedElsewhere = Number.isFinite(trigger.point) && trigger.used < trigger.point * 0.75
      if (foldedElsewhere) {
        logLine(
          ctx,
          'info',
          'context-truth: %s was folded by something else (used=%s, prep point=%s); the note at %s went unused and is released',
          sessionId,
          trigger.used,
          trigger.point,
          state.ready.path,
        )
        state.ready = null
        state.reminders = 0
        state.reminderTurn = null
        state.wokenAt = null
        persist(options, sessionId, state)
        return
      }
      noteOnce(
        `below-point:${sessionId}`,
        'info',
        'context-truth: %s registered a handoff but the reading (%s) is below the prep point (%s); keeping it for the next round end',
        sessionId,
        trigger.used,
        trigger.point,
      )
      return
    }

    const note = state.ready
    folding = true
    Promise.resolve()
      .then(() => requestFold(ctx, agent, options, services, new AbortController().signal))
      .then(
        (outcome) => {
          if (outcome === undefined) {
            noteOnce(
              `no-service:${sessionId}`,
              'warn',
              'context-truth: handoff mode found neither the realm /compact command nor a reachable compaction service (upstream discussion 9425); the note at %s is kept',
              note.path,
            )
            return
          }
          if (!outcome.folded) {
            // The channel has already logged *why* it did not commit (refused,
            // cancelled, nothing to compact); this line records the consequence.
            const reason = outcome.reason === undefined ? 'no-range' : outcome.reason
            logLine(
              ctx,
              reason === 'error' ? 'warn' : 'info',
              'context-truth: the fold did not commit for %s (%s); the note at %s is kept for the next round end',
              sessionId,
              reason,
              note.path,
            )
            return
          }
          const foldNo = state.foldNo + 1
          state.foldNo = foldNo
          state.ready = null
          state.reminders = 0
          state.reminderTurn = null
          state.wokenAt = null
          // The activation is durable before it is sent, which is the one thing the
          // reference implementation this was modelled on does not do.
          state.pending = {
            id: randomUUID(),
            path: note.path,
            foldNo,
            createdAt: Date.now(),
            attempts: 0,
            deliveredAt: null,
          }
          persist(options, sessionId, state)
          logLine(
            ctx,
            'info',
            'context-truth: folded %s at the round end via %s (fold #%s, note %s)',
            sessionId,
            outcome.how,
            foldNo,
            note.path,
          )
          deliver(agent, options, sessionId, state)
        },
        (error) => logLine(ctx, 'warn', 'context-truth: handoff fold failed: %s', messageOf(error)),
      )
      .finally(() => {
        folding = false
      })
  }

  /**
   * The tool the model calls once the note exists.
   *
   * Registered as a plain definition rather than through `defineTool`, because
   * `@deepseek-ai/dsh-tools` is not resolvable from this package's own directory
   * (verified here: ERR_MODULE_NOT_FOUND) and a plugin that cannot load is worse
   * than a plugin that builds a four-field object itself. The registry only
   * requires `output: { schema, render }`, so this is the whole contract.
   */
  function toolDefinition() {
    return {
      name: HANDOFF_TOOL_NAME,
      description:
        'Register the handoff note you just wrote to the path context-truth named, so this round is folded and exactly one follow-up turn is activated to read it back. Only meaningful in handoff fold mode, and only for that exact path.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The handoff path context-truth named. Omit to use the path it chose for this session.',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: (args, exec) => {
        const options = resolve()
        const zh = options.language === 'zh'
        const agent = exec === null || exec === undefined ? undefined : exec.agent
        const session = agent === null || agent === undefined ? undefined : agent.session
        if (options.foldMode !== 'handoff') {
          return zh
            ? `✗ handoff_ready 只在 handoff 折叠模式下有效（当前：${options.foldMode}），没有登记任何东西。`
            : `✗ handoff_ready only applies in handoff fold mode (current mode: ${options.foldMode}); nothing was registered.`
        }
        if (session === null || session === undefined) {
          return zh ? '✗ handoff_ready 需要一个活着的会话，没有登记任何东西。' : '✗ handoff_ready needs a live session; nothing was registered.'
        }
        if (isDelegate(session)) {
          // With the delegate variant on, "refused" must still be actionable: the
          // child's registration is the file itself, and this call is the one step
          // it does NOT need.
          if (options.subagentHandoff) {
            return zh
              ? '✗ 当前是委派会话：交接式折叠不在子会话上执行，**写文件本身就是登记**，不需要调用这个工具。'
              : '✗ this is a delegated session: handoff folding does not run on a child, and writing the note file IS the registration — this tool is not needed.'
          }
          return zh
            ? '✗ 当前是委派会话，交接式折叠只在根会话上生效；没有登记任何东西。'
            : '✗ this is a delegated session, and handoff folding only applies to a root session; nothing was registered.'
        }
        const sessionId = sessionIdOf(session)
        if (sessionId === '') {
          return zh ? '✗ 无法识别当前会话，没有登记任何东西。' : '✗ could not identify this session; nothing was registered.'
        }
        const state = stateFor(options, sessionId)
        if (state.pending !== null && state.pending.deliveredAt === null) {
          return zh
            ? '✗ 本会话已经排了一次折叠，激活轮还没投递；这次不重复登记。'
            : '✗ a fold for this session is already queued and not yet activated; nothing was registered.'
        }
        const root = handoffRoot(options)
        const expected = handoffPathFor(root, sessionId, state.foldNo + 1)
        const given = args !== null && typeof args === 'object' && typeof args.path === 'string' ? args.path.trim() : ''
        if (given !== '' && !samePath(given, expected)) {
          return zh
            ? `✗ 这个路径不属于本会话的交接目录。\n  期望：${expected}\n  收到：${given}\n交接档只能放在插件管理的目录里，不能写进工作区。写到期望路径后再调用。`
            : `✗ that path is not the one this session owns.\n  expected: ${expected}\n  given:    ${given}\nHandoff notes stay in the plugin's own directory, never in the workspace. Write to the expected path and call again.`
        }
        const chars = handoffFileChars(expected)
        if (chars === null) {
          return zh
            ? `✗ 这个路径还没有文件：${expected}\n先把档写到这里（必须是这个路径），再调用 handoff_ready。`
            : `✗ there is no handoff note at ${expected}\nWrite it there first (that exact path), then call handoff_ready.`
        }
        if (chars < HANDOFF_MIN_CHARS) {
          return zh
            ? `✗ 交接档只有 ${chars} 字符（最少 ${HANDOFF_MIN_CHARS}）。它要能让折叠后的会话不看对话历史就接上：补上目标、已定案、证据、下一步，再调用。`
            : `✗ the note is only ${chars} characters (minimum ${HANDOFF_MIN_CHARS}). It has to let the folded session continue without this conversation: add the goal, the decisions, the evidence, the next action, then call again.`
        }
        state.ready = { path: expected, chars, at: Date.now() }
        persist(options, sessionId, state)
        logLine(ctx, 'info', 'context-truth: handoff registered for %s (%s chars) at %s', sessionId, chars, expected)
        return zh
          ? `✓ 交接档已登记（${chars} 字符）：${expected}\n本轮结束时会执行折叠，然后自动开一轮（仅一轮）让你读档。现在结束本轮：收尾正在写的文件，不要再开新任务。`
          : `✓ handoff registered (${chars} chars): ${expected}\nThis round is folded when it ends, and exactly one turn is activated to read it back. End this round now: finish the file you are writing, do not start a new task.`
      },
    }
  }

  // The handoff tool follows the live `foldMode`: `tools.register()` returns the
  // disposer that unregisters it, so `off`/`idle` deployments carry no extra tool
  // at all instead of shipping a definition whose body always refuses. The initial
  // state is reconciled here, and every `prepare` (one per request) keeps it in
  // step after a settings change.
  const tools = safeGet(ctx, 'tools')
  const toolsUsable = tools !== undefined && typeof tools.register === 'function'
  let toolDisposer = null

  if (!toolsUsable) {
    logLine(
      ctx,
      'warn',
      'context-truth: no tools service is reachable from this scope; handoff mode cannot register %s and will stay inert',
      HANDOFF_TOOL_NAME,
    )
  } else {
    // Mode switching is not the only way the row goes away: a reload or a disposed
    // fiber must not leave the registration behind.
    ctx.effect(
      () => () => {
        if (toolDisposer === null) return
        const dispose = toolDisposer
        toolDisposer = null
        dispose()
      },
      `context-truth: ${HANDOFF_TOOL_NAME} cleanup`,
    )
  }

  /**
   * Register the handoff tool only while the fold mode is `handoff`.
   *
   * `tools.register()` returns the exact disposer that unregisters the tool
   * (`dsh-tools` `register()`), so the tool can follow a live `foldMode` without a
   * reload. Reconciled from `prepare`, which runs inside the `agent/request`
   * waterfall, so a switch lands on the next request rather than the next process.
   *
   * @param options - resolved options for this call.
   */
  function syncHandoffTool(options) {
    if (!toolsUsable) return
    const want = options.foldMode === 'handoff'
    if (want === (toolDisposer !== null)) return
    try {
      if (want) {
        toolDisposer = tools.register(toolDefinition())
        logLine(ctx, 'info', 'context-truth: %s registered (fold mode is handoff)', HANDOFF_TOOL_NAME)
      } else {
        const dispose = toolDisposer
        toolDisposer = null
        dispose()
        logLine(ctx, 'info', 'context-truth: %s removed (fold mode is %s)', HANDOFF_TOOL_NAME, options.foldMode)
      }
    } catch (error) {
      logLine(ctx, 'warn', 'context-truth: could not sync %s with the fold mode: %s', HANDOFF_TOOL_NAME, messageOf(error))
    }
  }

  syncHandoffTool(resolve())

  // Prep runs inside a waterfall: synchronous, and it must never throw — its return
  // value is the model call's configuration.
  ctx.on('agent/request', (payload, next) => {
    try {
      prepare(payload === null || payload === undefined ? undefined : payload.agent, payload === null || payload === undefined ? undefined : payload.turn)
    } catch (error) {
      noteOnce('prep-error', 'warn', 'context-truth: handoff prep failed: %s', messageOf(error))
    }
    return next()
  })

  // The fold itself is async and runs after the emitting stack unwinds, so the
  // `followup` that activates the next round never re-enters the agent loop.
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle' || agent === null || agent === undefined) return
    Promise.resolve()
      .then(() => foldAtRoundEnd(agent))
      .catch((error) => logLine(ctx, 'warn', 'context-truth: handoff fold failed: %s', messageOf(error)))
  })

  function sweep() {
    const options = resolve()
    if (options.foldMode !== 'handoff') return
    try {
      const removed = sweepHandoffs(handoffRoot(options), Date.now(), HANDOFF_MAX_AGE_MS)
      if (removed > 0) {
        logLine(ctx, 'info', 'context-truth: recycled %s stale handoff note(s) older than %s days', removed, Math.round(HANDOFF_MAX_AGE_MS / 86400000))
      }
    } catch (error) {
      logLine(ctx, 'warn', 'context-truth: handoff sweep failed: %s', messageOf(error))
    }
  }

  // Backstop only: the primary recycling happens when the next note is handed out.
  try {
    Promise.resolve().then(sweep).catch(() => {})
    if (typeof ctx.setInterval === 'function') ctx.setInterval(sweep, HANDOFF_SWEEP_INTERVAL_MS)
  } catch {
    // A timer is a convenience, never a requirement.
  }
}

/** Install the dynamic runtime-context line. */
function installContextLine(ctx, resolve, services, notices) {
  /** Last band published per session (hysteresis memory); never rendered. */
  const bands = new WeakMap()
  /** Per-session pace state for the headroom estimate; never rendered raw. */
  const paces = new WeakMap()
  /** Last text handed out, so a failed read degrades to the previous line. */
  let lastText = renderUnknown(resolve())

  /**
   * The handoff reminder as its own runtime-context block.
   *
   * A separate contribution (rather than text appended to the occupancy line) is
   * what makes it show up as its own block in the snapshot, and because an empty
   * text is filtered out by the host's `renderContextSections`, "no reminder" is
   * literally "no section" — the snapshot is byte-identical to before.
   */
  const handoffNotice = (assembly) => {
    if (resolve().foldMode !== 'handoff') return ''
    const sessionId = sessionIdOf(assembly?.agent?.session)
    if (sessionId === '') return ''
    return notices.get(sessionId) ?? ''
  }

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

  // Bind both registrations to THIS plugin's fiber.
  //
  // The service returns a disposer, but it is created through `layers.effect` on
  // the *service's* context, so ignoring it leaves the variable registered for the
  // lifetime of the service — i.e. forever. The consequence is not cosmetic: after
  // one reload the name is taken, every later instance throws "already registered",
  // and this plugin's `apply` deliberately goes inert on that error, so the plugin
  // can never be reloaded into a new version again (observed live 2026-11-16: every
  // reload logged "another instance already owns the context line" while no other
  // instance existed). `ctx.effect` puts the disposer on our own fiber, which is
  // what a reload actually disposes.
  const bind = typeof ctx.effect === 'function' ? (fn, label) => ctx.effect(fn, label) : (fn) => fn()
  bind(
    () => ctx.systemPrompt.variable(VARIABLE_NAME, (assembly) => line(assembly)),
    'context-truth: runtime-context variable',
  )
  bind(
    () =>
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        // `order` is fixed at registration: the host snapshots the contribution list
        // per assembly, and moving it live would reshuffle the cached prefix for a
        // change nobody asked to see mid-turn.
        order: resolve().order,
        text: `{{${VARIABLE_NAME}}}`,
      }),
    'context-truth: runtime-context section',
  )
  bind(
    () => ctx.systemPrompt.variable(HANDOFF_VARIABLE_NAME, (assembly) => handoffNotice(assembly)),
    'context-truth: handoff variable',
  )
  bind(
    () =>
      ctx.systemPrompt.context({
        name: HANDOFF_CONTEXT_NAME,
        // Right after the occupancy line, and fixed for the same reason: the block
        // only changes when a reminder is published, never by reordering.
        order: resolve().order + 1,
        text: `{{${HANDOFF_VARIABLE_NAME}}}`,
      }),
    'context-truth: handoff section',
  )
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
  resolveFoldMode,
  handoffTrigger,
  handoffRoot,
  handoffPathFor,
  handoffPrepMessage,
  handoffDelegatePrepMessage,
  handoffDelegateFoldMessage,
  handoffWakeMessage,
  handoffActivationMessage,
  handoffActivationWakeMessage,
  handoffReapable,
  sweepHandoffs,
  readHandoffState,
  writeHandoffState,
  handoffFileChars,
  emptyHandoffState,
  safeSegment,
  sessionIdOf,
  isDelegate,
  samePath,
  HANDOFF_TOOL_NAME,
  HANDOFF_MIN_CHARS,
  HANDOFF_MAX_AGE_MS,
  HANDOFF_STATE_FILE,
  backendIdentity,
  render,
  renderUnknown,
  messageText,
  patchCompactionInstruction,
  patchCompactionRequest,
  isCompactionRequest,
  isTaggedCompactionRequest,
}
