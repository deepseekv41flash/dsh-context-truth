# dsh-context-truth

[English](README.en.md) · [简体中文](README.md)

> Give the model its **real** context occupancy — measured by the host and re-injected every turn — and stop the false claim "context is nearly exhausted" from surviving compaction.

A DSH (DeepSeek Harness) plugin · zero dependencies · no tools · no UI · no build step · MIT

---

## The problem it solves

**DSH never tells the model how many tokens it has used.** The model can only guess from how long the conversation feels, so on a long session it announces "context is nearly exhausted" while the real occupancy is **17%** — stops doing write work, and hands the task to a subagent.

Worse, that wrong call **survives compaction**:

1. the model writes "my context is nearly exhausted";
2. the sentence lands in a compaction summary (verbatim from a real session: `- Session budget is nearly exhausted; ...`);
3. the checkpoint's fixed preamble reads *"Treat the captured context as **established background**"*;
4. so every compaction re-injects the false belief as established background — and it is **never corrected** when the real occupancy falls back.

This plugin cuts both ends of that chain.

## Two capabilities

### 1. Measured occupancy line (on by default)

One dynamic runtime-context line, rendered every turn from the host's own token meter:

```
Context occupancy (host-measured): 300K / 1.00M tokens used (30%). Automatic compaction
fires at 678K (68% of the window). About 378K tokens of headroom remain before it.
There is still real headroom — keep going, and keep durable notes or commits current as
you work. This host-measured line is the only authority on context pressure; never
estimate it from the conversation's length.
```

Four bands (`ample` / `moderate` / `tight` / `critical`) keyed to the **auto-compaction point**, with 5% hysteresis. The `ample` band additionally declares that every earlier "context is nearly full" claim — including ones inside compacted checkpoints — is stale.

### 2. Compaction directive rules (on by default)

The last message of a compaction call (`purpose: 'compaction'`) is the summarizer directive. Through the **public `llm/stream` waterfall** the plugin appends two rules to its tail — tail-only, so the cached prefix stays byte-identical:

```
- Never record the assistant's own statements about its remaining context, token budget, or
  context-window pressure (for example "context is nearly exhausted", "running out of budget",
  "hand off before context runs out"). Those readings are measured by the host and delivered
  separately; a model's guess about them is not a durable fact.
- Never record a plan to stop, defer, or hand off work whose only justification was context
  pressure. Record the actual task state instead.
```

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

The package ships `dsh.bundle.patch`, so listing it in a profile's `dsh.profile.bundles` assembles it too. **No dependencies and no build step**: `lib/index.js` is both the source and the artifact.

## Configuration (every key optional)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for capability 1 |
| `language` | `en` | `en` / `zh` wording |
| `order` | `100` | Placement inside the runtime-context block (sandbox is 110, approval 115 — so it comes first) |
| `quantumPercent` | `5` | Display step as a percentage of the window; sets the re-injection cadence |
| `thresholdRatio` | `0.8` | Mirror of `dsh-compaction-basic` |
| `headroomTokens` | `65536` | Mirror of `dsh-compaction-basic` |
| `reservedCompletionTokens` | `null` | `null` reads the routed request's own `maxTokens` |
| `moderateAt` / `tightAt` | `0.5` / `0.85` | Band edges, as a fraction of the compaction point |
| `hysteresis` | `0.05` | Margin required before leaving a band downward |
| `authoritative` | `true` | Append the "this line is the only authority" clause |
| `staleClaimClause` | `true` | Retire earlier "context is nearly full" claims in the calm band |
| `logBandChanges` | `true` | Log one `ctx.logger.info` per band change |
| `patchCompactionPrompt` | `true` | Whether to extend the compaction directive |
| `compactionRules` | see above | Rule array; `[]` disables capability 2 |

## Cost (stated honestly)

The runtime-context snapshot is **not re-injected while its bytes are unchanged**, so readings are quantized. Measured on a 1M window with the 678K compaction point and `quantumPercent: 5`:

* one full cycle (0 → 678K) changes the text **52 times**, roughly once per 13K tokens;
* the occupancy line is ≈ **124 tokens**, plus the other sections of the same snapshot ≈ 250 tokens;
* together that is **< 2%** of the cycle's budget.

What you get for it: the model stops halting or handing off because it *thinks* it is running out of context. Raise `quantumPercent` to spend less.

## Compatibility & boundaries

* Measured on **dsh 0.2.0-rc.2**; only public seams are used (`systemPrompt.variable/context`, the `llm/stream` waterfall, the `tokenMeter` / `sessionProjections` services) — no private fields.
* If an agent preset sets `includeRuntimeContext: false` (for example `liangshen`), the runtime suppresses **every** runtime-context contribution and capability 1 does not apply (capability 2 is unaffected).
* If a host froze the request envelope (this version does not), capability 2 logs one warning and skips — it never breaks a model call.
* **Mounting twice in one scope does not fail**: bundle assembly plus a runtime injection are two assembly paths for the same plugin; the second instance detects the taken name, stays silent (one `info` line) and the first keeps serving — it never becomes a failed plugin row.
* The plugin registers no tools and does not touch the tool catalog, so it adds nothing to the first-turn prefill.

## Verify

```sh
npm test          # 21 unit tests: banding, hysteresis, quantization, degradation, directive patching, idempotence
```

After installing, open a new session and send one message: expanding that turn's runtime context block should show `Context occupancy (host-measured): …`, and the log carries `context-truth: none -> ample (used=… window=1000000 compactionAt=678464)`.

## Uninstall

Remove the row from the profile patch / bundles list; a restart leaves nothing behind — no tools, no client, no state on disk.

## License

MIT
