# dsh-context-truth

[English](README-en.md) · [简体中文](README.md)

> Give the model its **real** context occupancy — measured by the host and re-injected every turn — and stop the false claim "context is nearly exhausted" from surviving compaction.

A DSH (DeepSeek Harness) plugin · one peer dependency (the host's own `schemastery`) · needs the host services `tokenMeter` and `compaction` (both shipped by `dsh-base`) · no tools · no build step · MIT

---

## The problem it solves

**DSH never tells the model how many tokens it has used.** The model can only guess from how long the conversation feels, so on a long session it announces "context is nearly exhausted" while the real occupancy is **17%** — stops doing write work, and hands the task to a subagent.

Worse, that wrong call **survives compaction**:

1. the model writes "my context is nearly exhausted";
2. the sentence lands in a compaction summary (verbatim from a real session: `- Session budget is nearly exhausted; ...`);
3. the checkpoint's fixed preamble reads *"Treat the captured context as **established background**"*;
4. so every compaction re-injects the false belief as established background — and it is **never corrected** when the real occupancy falls back.

This plugin cuts both ends of that chain.

## Three capabilities

### 1. Measured occupancy line (on by default)

One dynamic runtime-context line, rendered every turn from the host's own token meter:

```
Context occupancy (host-measured): 300K / 1.00M tokens used (30%). Automatic compaction
fires at 678K (68% of the window). About 378K tokens of headroom remain before it.
There is still real headroom — keep going, and keep durable notes or commits current as
you work. This host-measured line is the only authority on context pressure; never
estimate it from the conversation's length.
```

Four bands (`ample` / `moderate` / `tight` / `critical`) keyed to the **auto-compaction point**, with 5% hysteresis. The `ample` band additionally declares that every earlier "context is nearly full" claim — including ones inside compacted checkpoints — is stale. A reading that rounds below one display step renders as `under 50K / 1.00M tokens used (under 5%)` — never as a `0` that would contradict the headroom printed on the same line.

**Headroom in steps**: the `tight` and `critical` bands translate the remaining headroom into this session's own pace — `At this session's recent rate that is roughly 6 more steps.` It is measured, not guessed: per-step growth is the **median** of the deltas between step boundaries, with the step number taken from the host's own `(turn, step)` counter. One 30K tool dump therefore cannot drag it, and a fold re-base (measured: 200K → under 50K within three seconds) clears the history instead of being averaged against it. The figure is bucketed onto `1 / 2 / 3 / 5 / 8 / 13 / 20+` and rounded **down**, the same direction as the headroom itself. The top rung is open-ended on purpose: in a live session the raw count ranged 23–38 across consecutive steps, straddling the old `21 / 34` boundary and flipping the line four times in 90 seconds — one snapshot re-commit caused by nothing but the flip — while above ~20 steps the exact figure changes no decision. The rung also settles like a band, asymmetrically: **downward at once** (less room is never held back), **upward only past `paceMargin` (25%)** above the higher rung, so a straddling estimate cannot flip the line and a genuinely slower session is never frozen at a low rung. It is display-only: it moves no band edge, threshold, or folding decision — switching it off reproduces the 0.1.3 line exactly.

**The `tight` band says nothing by default.** It reports the numbers (used, threshold, remainder, roughly how many steps) and adds **no closing sentence**. Three wordings were tried in the field — 0.1.3 ordered "finish the step, then hand off", 0.1.4 described the coming fold — and both made the model narrate compaction in its own replies and lose momentum, in the band that re-injects most often (measured: 333 commits, median gap 45s, runs of 4–20s). `tightAdvice: 'inform'` restores the 0.1.4 sentence, `'stop'` the 0.1.3 imperative.

**The line says outright that it is telemetry — and not an allowance to draw down.** Its closing clause is "Background telemetry from the host, and the only authority on context pressure: do not mention it, do not estimate or count it down yourself — it is restated whenever it changes — and take no action about compaction; the host folds between steps automatically." The second half is as evidence-driven as the first: a live model quoted the figure correctly for a while and then spent it in its head (`30K → 28K → 16K → 10K → 7K → 5K`) while the host's number sat still at `About 10K` (restated only when it changes), and twelve minutes later announced "Context is nearly exhausted (~5K)" — a figure the host never reported.

**The line answers "how much context do I have left" too.** It used to print only the headroom to the fold, never the free window — and a live model answered the first question with the second figure, announcing "Very low context" at 10K of headroom while **350K of the window was free**. Both numbers were true; only one was an answer. Every band now carries `About 300K of the window is still free`, and **no figure was removed**: dropping the headroom near the fold was considered and rejected, because both endpoints (used, and the fold point) stay printed, so the model can subtract them anyway — suppressing a derivable number would re-create the original bug's precondition (no ground truth) exactly where speculation is most likely. It shares the `used` display step, so it adds no re-injection of its own; `freeClause: false` removes it.

**The two small bands define what the fold is.** Numbers alone left a gap a live model walked into: eleven seconds after the line read `Under 10K tokens of headroom remain before it`, it wrote "Very low context. I must do this in as few commands as possible, then a short answer." It had read the figure correctly and took "room before the fold" for "context left", while the window still held 350K and the fold only replaces older turns with a summary. `tight` therefore carries a **definition** (not an instruction) — "The fold is routine, not the end of the window: older turns become a summary and work continues after it" — and `critical` the short form, "The window is not exhausted — work continues after the fold." Neither contains a task instruction, so neither can regress into the 0.1.3 "wrap up and hand off" nudge. `foldClause: false` removes them.

**The headroom step stays coarse near the point.** An earlier build shrank it to 2K as the room ran out — the exact band that re-injects most — so the figure ticked on nearly every step. The floor is now 10% of the window quantum (10K on a 1M window): within a few tens of thousands of tokens the pace estimate is the useful signal, and a remainder smaller than one step still renders honestly as `Under 10K`. Over a walk from 128K of headroom to zero, the line re-commits **11 times instead of 23**.

### 2. Compaction directive rules (on by default)

The last message of a compaction call is the summarizer directive. Through the **public `llm/stream` waterfall** the plugin appends two rules to its tail — tail-only, so the cached prefix stays byte-identical:

```
- Never record the assistant's own statements about its remaining context, token budget, or
  context-window pressure — not even quoted, paraphrased, or listed as an example, and not
  when an earlier checkpoint already carries one: drop that wording instead of copying it
  forward. Those readings are measured by the host and delivered separately; a model's guess
  about them is not a durable fact.
- Never record a plan to stop, defer, or hand off work whose only justification was context
  pressure. Record the actual task state instead.
```

The call is identified by the `purpose: 'compaction'` tag its caller sets. When a deployment sets no tag, the fallback requires the trailing message to **begin** with the directive — so a tool result that merely quotes the engine (a source dump, a log excerpt, a grep hit) is never patched by mistake, and can never spend the one-shot failure warning either.

### 3. Fold at the idle boundary (optional, **off by default**; whether it can work depends on the backend being reachable)

The host's automatic compaction is a *crossing* trigger, and the behaviour a model adopts near the point — batching round trips, avoiding risky edits, stopping mid-iteration to commit WIP — is exactly what keeps the reading below it. Measured on one live session:

```
4 hours with no fold · every turn 2–8 steps long · three consecutive "continue"
instructions unable to finish the same task
the reading parked at "Under 10K tokens of headroom remain"
```

Every turn therefore starts with two to eight steps of room, and a task that needs continuous iteration — debugging a 500-line harness, say — never converges. This capability folds once at the model's **own turn boundary** (`agent/status === 'idle'`): when the reading comes within `foldAtIdleMarginPercent` (5% of the window by default — 50K on a 1M window) of the point, it calls the official `compaction.compactNow()`. The official engine only accepts that call while the agent is idle, which is exactly the moment this fires. The fold pushes the headroom back into the hundreds of thousands, so the condition stops holding: **one fold per cycle**.

**Off by default**: it spends a summarizer call and rewrites the window, which is a policy decision rather than telemetry. The switch lives on the settings page (below).

## Data sources (all host-measured — nothing is estimated)

| Item | Source |
|---|---|
| Used | `tokenMeter.measure(session).totalTokens` — the host's price for the next request, and the exact number auto-compaction compares against |
| Window | `session.requestContext().contextWindow` |
| Fallback | the `contextPressure` projection (provider-reported prompt-side usage) — **the same figure the Web UI's context ring renders** |
| Compaction point | `min(window × thresholdRatio, window − reserved completion − headroom)`, the same formula `dsh-compaction-basic` uses |
| Summarizer directive | the last message of the `purpose: 'compaction'` request at the `llm/stream` waterfall |

## Install

```sh
# npm
dsh plugin --profile web add dsh-context-truth

# or straight from the repository
dsh plugin --profile web add github:deepseekv41flash/dsh-context-truth
```

Or write the row into a profile's own patch layer:

```yaml
# <DSH home>/profiles/<profile>/cordis.patch.yml
- insert:
    - id: context-truth
      name: dsh-context-truth
      config:
        language: en        # optional; 'en' (default) or 'zh'
```

The package ships `dsh.bundle.patch`, so listing it in a profile's `dsh.profile.bundles` assembles it too. **No build step**: `lib/index.js` is both the source and the artifact.

**Two host services are hard requirements**: `inject = ['systemPrompt', 'tokenMeter', 'compaction']`. They are not optional — cordis wires a service only into a context that declares the injection (`provide` stores the implementation in the providing context's store, so sibling entries cannot see each other), so an undeclared service simply cannot be read. `@deepseek-ai/dsh-base` mounts both (`token-meter`, `compaction-basic`), which every standard deployment has; a custom profile that mounts only one of them will not load this plugin.

## Configuration (every key optional)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for capability 1 |
| `language` | `en` | `en` / `zh` wording |
| `order` | `100` | Placement inside the runtime-context block (sandbox is 110, approval 115 — so it comes first) |
| `quantumPercent` | `5` | Display step as a percentage of the window; sets the re-injection cadence |
| `paceEstimate` | `true` | Translate the headroom into this session's pace (`tight` / `critical` bands) |
| `paceSamples` | `16` | Per-step deltas the median is taken over |
| `paceMinSamples` | `3` | Samples required before any estimate is shown |
| `paceMargin` | `0.25` | Margin a higher rung must clear before the line promises more steps |
| `thresholdRatio` | `0.8` | Mirror of `dsh-compaction-basic` |
| `headroomTokens` | `65536` | Mirror of `dsh-compaction-basic` |
| `reservedCompletionTokens` | `null` | `null` reads the routed request's own `maxTokens` |
| `moderateAt` / `tightAt` | `0.5` / `0.85` | Band edges, as a fraction of the compaction point |
| `hysteresis` | `0.05` | Margin required before leaving a band downward |
| `tightAdvice` | `none` | `tight` closing sentence: `none` adds none (default), `inform` states the cost, `stop` keeps the 0.1.3 imperative |
| `authoritative` | `true` | Append the "this line is the only authority" clause |
| `staleClaimClause` | `true` | Retire earlier "context is nearly full" claims in the calm band |
| `foldClause` | `true` | Define what the fold is in the `tight` / `critical` bands |
| `freeClause` | `true` | Report how much of the window is still unused |
| `logBandChanges` | `true` | Log one `ctx.logger.info` per band change |
| `patchCompactionPrompt` | `true` | Whether to extend the compaction directive |
| `compactionRules` | see above | Rule array; `[]` disables capability 2 |
| `foldAtIdle` | `false` | Enable capability 3 (fold at the idle boundary) |
| `foldAtIdleMarginPercent` | `5` | Fold once the headroom is within this percent of the window (50K on a 1M window) |
| `foldAtIdleMethod` | `auto` | Channel for the request: `auto` runs the session's own `/compact` first (realm view — works on a stock deployment) and falls back to the service; `command` / `service` force one |
| `foldAtIdleCooldownMs` | `60000` | Minimum gap between attempts, so a failure cannot hammer the engine |

**Configuration goes in the profile patch** — the same place `subagent`'s `maxDepth` and `bash-terminal`'s `defaultShell` live:

```yaml
- id: context-truth            # the id the bundle patch declares
  name: dsh-context-truth
  config:
    foldAtIdle: true
    foldAtIdleMarginPercent: 5
```

A change takes effect **immediately**: the host's volatile mechanism writes the new value straight into the running config reference (`loader._commitVolatile`) instead of reloading the plugin, which is why the plugin resolves its options per use rather than snapshotting them at mount. Verified live: editing that row flipped `foldAtIdle` to `true` in the running config with no restart.

> ⚠️ **This DSH build has no "render a form from the schema" mechanism for plugins.** Every plugin whose settings page exists (subagent, bash-terminal/shell, agent-loop, web-search) ships a **hand-written card in its own client package**, registered into the `plugins.item` slot; the generic `plugins.row.config` slot is registered by nobody. Exporting a Schemastery `Config` does make the host register the namespace (measured: `ns=context-truth`, `applies=live`) — but **no UI renders a generic form for a third-party plugin**, so the switches live in the patch.
>
> A real settings-page toggle would need a **client card package** for this plugin, modelled on `@deepseek-ai/dsh-client-ui-settings-subagent`: register a `plugins.item` cell and bind a `z.boolean()` control to the settings form. The host will not generate one.

`enabled` (the master switch) is best left to the on/off toggle on the plugin list — that one does reload the plugin.

## Cost (stated honestly)

The runtime-context snapshot is **not re-injected while its bytes are unchanged**, so readings are quantized. Measured on a 1M window with the 678K compaction point and `quantumPercent: 5`:

* one full cycle (0 → 678K) changes the text **52 times**, roughly once per 13K tokens;
* the occupancy line is ≈ **124 tokens**, plus the other sections of the same snapshot ≈ 250 tokens;
* together that is **< 2%** of the cycle's budget.

What you get for it: the model stops halting or handing off because it *thinks* it is running out of context. Raise `quantumPercent` to spend less.

## Compatibility & boundaries

* Measured on **dsh 0.2.0-rc.2**; only public seams are used (`systemPrompt.variable/context`, the `llm/stream` waterfall, the `tokenMeter` / `sessionProjections` services). One exception: the pace estimate reads the host's `agent.phase.{turn, step}` instance field, which is not documented — when it is absent the clause is omitted entirely and the line falls back to what 0.1.3 rendered, never to a guess.
* If an agent preset sets `includeRuntimeContext: false` (for example `liangshen`), the runtime suppresses **every** runtime-context contribution and capability 1 does not apply (capability 2 is unaffected).
* If a host froze the request envelope (**this version does not** — verified by capturing a real compaction request), capability 2 logs one warning and skips — it never breaks a model call. That warning is reserved for the engine's own tagged call, so a look-alike request can never silence a later real failure.
* **Mounting twice in one scope does not fail**: bundle assembly plus a runtime injection are two assembly paths for the same plugin; the second instance detects the taken name, stays silent (one `info` line) and the first keeps serving — it never becomes a failed plugin row.
* The plugin registers no tools and does not touch the tool catalog, so it adds nothing to the first-turn prefill.

## Verify

```sh
npm test          # 51 unit tests: banding, hysteresis, quantization, free window, fold definition, idle fold and its guards, live settings changes, schema-default parity, pace estimate, degradation, directive patching, look-alike rejection, idempotence
```

After installing, open a new session and send one message: expanding that turn's runtime context block should show `Context occupancy (host-measured): …`, and the log carries `context-truth: none -> ample (used=… window=1000000 compactionAt=678464)`.

## Uninstall

Remove the row from the profile patch / bundles list; a restart leaves nothing behind — no tools, no client, no state on disk.

## License

MIT
