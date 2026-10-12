# Changelog

## 0.2.0

> **能力 3（空闲边界折叠）能否工作，取决于接缝由哪个后端提供、以及它是否对插件可达。**
> 实测（`0.2.0-rc.2`）：
> - 官方 `@deepseek-ai/dsh-compaction-basic`（base bundle 层）**不可达**——`ctx.get` /
>   `ctx.reflect.get(…, false)` / 属性访问 / 活着的 `agent.ctx` 全部取不到，声明
>   `inject: ['…','compaction']` 更会让条目**永久 pending**（插件完全不加载）。已向上游报告：
>   [deepseek-harness#9425](https://github.com/deepseek-ai/deepseek-harness/discussions/9425)。
> - `@aiwayds/dsh-dcp` 0.13.0（profile bundle 层，与本插件同层）**可达** ✓——实测接缝由
>   `DcpEngine > BasicCompactionEngine > CompactionEngine` 提供，`ctx.compaction.compactNow()`
>   调用成功，能力 3 因此可用（本 profile 已验证）。
>
> 启动时那行诊断会写明实际后端：`context-truth: services wired (tokenMeter=… compaction=object/DcpEngine>…)`。
>
> **折叠请求有两条通道（`foldAtIdleMethod`）**，默认 `auto` 先命令后服务：
> 1. **命令通道**：`ctx.commands.execute(agent, '/compact', [], signal)` —— 走**该 agent 的 realm 视图**，
>    因此落到该会话本该用的那个后端上（与人类敲 `/compact` 完全一致）。**这是原版部署唯一可行的
>    通道**（profile 层的插件注入不了 preset realm 的服务，见 #9425），也让折叠风格与会话自身一致。
> 2. **服务通道**：`ctx.compaction.compactNow()` —— 同层有可达 provider 时（如 `@aiwayds/dsh-dcp`）
>    最直接，也是 realm 没注册 `compact` 命令时唯一的办法。
> 命令通道失败（realm 无该命令、或拒绝）会**自动回退**到服务通道，两者都不通时只记一次说明日志。
> 本 profile 因为装了 dcp，显式选了 `service`（确定性、零 LLM 调用），见 profile patch 注释。
>
> 与 dsh-dcp 的分工：它的轮数触发（`roundInterval`，默认每 50 条 assistant message、在空闲
> 边界执行）是**活动驱动**的；本插件的触发是**压力驱动**的（余量进入窗口 5% 时、在同一个空闲
> 边界）。任何一次折叠都会重置 dsh-dcp 的轮数时钟，所以两者不会互相打转。
>
> 另需注意（重要，且我们一开始写错了）：dsh-dcp 的"关掉官方后端 + 接管接缝"只作用于**它自己所在
> 的那一层**。每个 agent preset 里还有一个 `cordis:group` realm，里面**各自挂着一份官方
> `compaction-basic`（LLM 摘要）+ `command-compact`**（preset 文件里连 `tokenMeter` 留在宿主、
> `compaction` 放进 realm 都是有注释的刻意设计）。于是同一个进程里可能同时存在两个后端：
> profile 层的 dcp（确定性，本文提到的空闲折叠走这条）与 realm 里的官方后端（LLM，`/compact`
> 与 realm 内的自动折叠走这条）。**因此能力 2 并不是空转**——它对 realm 里那些**会调用 LLM 摘要**
> 的折叠依然生效；只有 dcp 自己执行的确定性折叠没有摘要指令可补。

- **Capability 3: fold at the idle boundary (`foldAtIdle`, off by default).** The host's automatic
  compaction only fires when the meter *crosses* the point, and the behaviour a model adopts as it
  approaches — batching round trips, refusing risky edits, stopping mid-iteration to commit WIP —
  is precisely what keeps the reading below it. Measured on a live session: **four hours with no
  fold, every turn 2–8 steps long, three consecutive "continue" instructions unable to finish the
  same task**, the reading parked at `Under 10K tokens of headroom remain`, and the model declining
  a patch to a 584 KB generator because "I can't verify much in 10K". The fix is not wording (four
  rounds of that changed narration, not the equilibrium): it is *when* the fold happens. This
  capability calls the official `compaction.compactNow()` at the model's own turn boundary
  (`agent/status === 'idle'`) once the headroom is within 5% of the window. The engine only accepts
  that call while the agent is idle, so the timing is the supported one; a fold pushes the headroom
  back into the hundreds of thousands, so it fires **once per cycle**. Failure is logged and
  swallowed, attempts are rate-limited, and a missing compaction service warns exactly once — a
  trigger must never break a turn.
- **Configuration lives in the profile patch, and applies live.** The plugin exports a Schemastery
  `Config` and the host registers it — the settings service reports `ns=context-truth`,
  `applies=live`, and a `value` carrying the patch's override. But this DSH build has **no generic
  renderer** for a third-party plugin's form: every plugin whose settings page exists (subagent,
  shell, agent-loop, web-search) ships a hand-written card in its own *client* package, and the
  generic `plugins.row.config` slot is registered by nobody. So the switches go where `subagent`'s
  `maxDepth` goes:
  ```yaml
  - id: context-truth
    config:
      foldAtIdle: true
  ```
  Verified live: editing that row flipped `foldAtIdle` to `true` in the running config with **no
  restart** (`patchReload: live`). Three host details are load-bearing, and the first attempt got all
  three wrong — it rendered no form, then silently disabled capability 2:
  - The settings service builds its form with `volatileForm(schema)`, which keeps only nodes marked
    `.volatile()`. Every field carries the marker now; `enabled` is the deliberate exception, because
    it decides whether the line is registered at all.
  - A volatile change is committed **into the running reference** (`loader._commitVolatile` →
    `updateVolatile`) rather than by reloading the plugin. Options are therefore resolved on every
    use instead of snapshotted in `apply`, the listeners install unconditionally and gate themselves
    per event, and a config value that arrives as a reference cell is unwrapped exactly as the host's
    own adapters do (`plainOptions`). Without that, an edit in the patch would have changed nothing
    until the next restart — a worse failure than a missing form, because it looks like it worked.
  - **A field with no schema default is materialized as `[]`**, and for `compactionRules` `[]` means
    "append nothing" — so adding the schema switched capability 2 off silently until the default was
    given the real rules. A test now pins every schema default against `DEFAULT_OPTIONS`.
  This costs the plugin its zero-dependency claim: `@deepseek-ai/schemastery` is now a declared peer
  dependency (published on npm, and already shipped by every host that runs the plugin).
- **The idle fold's first live trigger folded nothing: `ctx.get` is not how a service is reached.**
  At 22:44 the trigger itself was correct — inside the 5% margin, at an idle boundary — and the log
  said so: `foldAtIdle is enabled but no compaction service is mounted; not folding`. `ctx.get(name)`
  resolves through `ctx.reflect`, and it returned nothing for `compaction` from this plugin's context.
  The occupancy line had been quietly surviving on the `contextPressure` projection fallback.
- **The second design failed too, and the third one has a working precedent.** `ctx.inject(['compaction'], cb)`
  never ran its callback (a second live trigger at 16:56 the next day logged the same warning). The
  service is now reached the way `dsh-command-compact` reaches it: declare it,
  `inject = ['systemPrompt', 'tokenMeter', 'compaction']`, then read `ctx.compaction` — and two manual
  `/compact` runs in the same profile (10-09 and 10-10, each with a `sourceCommandId`, a summary and a
  clean end) are the proof that path works. `provide` registers the isolate symbol on the root but
  stores the implementation in the *providing* context's store, so a sibling entry is reachable only
  through cordis injection. Services are still resolved **per use**, never snapshotted, and a one-line
  startup diagnostic reports what was wired. Cost: both services are now required, and
  `@deepseek-ai/dsh-base` mounts both (`token-meter`, `compaction-basic`); a profile that mounts neither
  will not load this plugin.
- Five more tests (49 total): the idle fold's trigger and its guards (running agent, calm session,
  in-flight attempt, missing service, rejected call), the pure decision function it is built on, the
  wiring that delivers the service, a reference cell flipped at runtime to prove a settings change
  lands without a reload, and the schema-default invariant above.

## 0.1.4

- **The `tight` band stopped talking about compaction, and this is the change that matters most.**
  Three successive wordings were tried in the field: 0.1.3 ordered a hand-off, 0.1.4 described the
  coming fold, and both made the model *narrate* compaction in its own replies and lose momentum —
  worst in the one band that re-injects most often. A live session made it measurable: the tight
  band was committed **333 times**, median gap 45s with runs of 4–20s, so the model read a fresh
  fold notice every step or two. The default (`tightAdvice: 'none'`) now adds **no closing sentence
  at all** — the numbers are the message — `'inform'` restores the 0.1.4 sentence and `'stop'` the
  0.1.3 imperative.
- **The line says outright that it is telemetry, not a task — and not an allowance to draw down.**
  The closing clause now reads "Background telemetry from the host, and the only authority on
  context pressure: do not mention it, do not estimate or count it down yourself — it is restated
  whenever it changes — and take no action about compaction; the host folds between steps
  automatically." Both halves are evidence-driven. Compaction is host-owned and needs nothing from
  the model, so saying so removes the impulse to plan or announce it — and a live session showed why
  the second half is needed too: the model read the figure correctly, then spent it in its head
  across the following steps (`30K → 28K → 16K → 10K → 7K → 5K`) while the host's number sat still at
  `About 10K` (it is restated only when it changes). Twelve minutes later it announced "Context is
  nearly exhausted (~5K)", a figure the host never reported. A measurement has to be labelled a
  measurement.
- **The line now also answers "how much context do I have left".** It always printed the headroom to
  the fold and never the free window. A live model answered the first question with the second figure
  and announced "Very low context" at 10K of headroom while **350K of the window was free** — both
  numbers true, only one of them an answer. Every band now carries `About 300K of the window is still
  free`, and **no figure was removed**: dropping the headroom near the fold was considered and
  rejected, because both endpoints (used, and the fold point) stay printed, so the model can subtract
  them anyway — suppressing a derivable number would re-create the original bug's precondition (no
  ground truth) exactly where speculation is most likely. Quantized onto the same display step as
  `used`, so it adds no re-injection of its own; `freeClause: false` removes it.
- **The small bands now define what the fold is.** The numbers alone left a gap a live session walked
  into: eleven seconds after the line said `Under 10K tokens of headroom remain before it`, the model
  wrote "Very low context. I must do this in as few commands as possible, then a short answer." It had
  read the figure correctly — it took "room before the fold" to mean "context left", while the window
  still held 350K and the fold only reorganizes it. The `tight` band now adds "The fold is routine,
  not the end of the window: older turns become a summary and work continues after it", and `critical`
  the shorter "The window is not exhausted — work continues after the fold." Both are definitions,
  not instructions — nothing to do, nowhere to go — so neither can become the 0.1.3 "hand off" nudge.
  `foldClause: false` removes them.
- **The remaining-headroom step stays coarse near the point.** It used to shrink to 2K as the room
  ran out — precisely where the line re-injects most — so the figure ticked on nearly every step.
  The floor is now 10% of the window quantum (10K on a 1M window): within a few tens of thousands
  of tokens the pace estimate is the useful signal, and a remainder smaller than one step still
  renders honestly as `Under 10K`. Over a walk from 128K of headroom down to zero the line now
  re-commits **11 times instead of 23**.
- **The remaining headroom is translated into this session's own pace.** In the `tight` and
  `critical` bands the line reports how many more steps the headroom covers — `At this
  session's recent rate that is roughly 6 more steps.` It is measured, not guessed: the per-step
  growth is the median of recent deltas between step boundaries, taken from the host's own
  `(turn, step)` counter together with the meter reading the line already reports.
- **A fold re-base discards the pace history instead of poisoning it.** After a compaction the
  meter re-bases (measured in a live session: 200K → under 50K within three seconds); that
  negative delta resets the samples, so the estimate disappears and is re-earned rather than
  averaged against a stale baseline.
- **Bucketed, rounded down, and settled.** The figure is bucketed onto `1 / 2 / 3 / 5 / 8 / 13 / 20+`
  — the same direction as the headroom itself, so the line never promises more remaining steps than
  the session's own rate supports. The first build of this feature published the rung directly and
  a live session showed why that fails: the raw count ranged 23–38 across consecutive steps,
  straddled a `21 / 34` boundary, and flipped the line four times in 90 seconds — one snapshot
  re-commit caused by nothing but the flip. The top rung is therefore open-ended (`20+`, where the
  exact figure changes no decision), and the rung settles like a band: downward takes effect at once
  (less room is never held back), upward must clear the higher rung by `paceMargin` (0.25) so a
  straddling estimate cannot flip the line while a genuinely slower session still gets the higher
  figure. Replayed against the observed sequence, the rung now renders once instead of five times.
- **Display-only.** It never moves a band edge, the threshold, or any decision to fold. With
  `paceEstimate: false`, or on a host that exposes no step counter, the published line is
  byte-for-byte what 0.1.3 produced.
- 42 unit tests (was 28): step-boundary sampling, re-assembly inside one step, fold re-basing,
  median robustness against a 90K tool dump, rung rounding and settling (including a replay of the
  observed flip sequence), the two `tight` wordings, and byte-identity when the pace feature is off.

## 0.1.3

Four changes, all from capturing a real compaction request in a live session (and from the host
log line that capture explained):

- **A request that merely quotes the directive is no longer mistaken for a compaction call.**
  Detection trusted a substring match on the trailing message, so an ordinary turn whose last tool
  result dumped the engine source or a session log was treated as the summarizer call — one real
  tool result contained 10 marker hits. A caller-set `purpose` is now authoritative, and the
  tagless fallback requires the trailing message to *begin* with the directive.
- **A look-alike can no longer spend the one-shot failure warning.** In the wild it did: the
  warning fired for an ordinary turn, which would have left a later *real* failure completely
  silent. Only a call tagged `purpose: 'compaction'` may consume the warning now.
- **A reading below one display step says so instead of rendering `0`.** After a compaction the
  meter reads 30–50K against a 50K step, so the line printed `0 / 1.00M tokens used (0%)` while
  the same line reported ~600K of headroom — an empty window and a nearly full one at once. It now
  prints `under 50K / 1.00M tokens used (under 5%)` (`不足 50K`), and a headroom inside its own
  step prints `Under 2K` rather than `less than 1K`.
- **Rule 1 forbids quoting, not just asserting.** It now bans recording such claims quoted,
  paraphrased, or listed as an example, and tells the summarizer to drop the wording when an
  earlier checkpoint already carries it. The rule embeds no quotable example phrases of its own.
- 28 unit tests (was 21), including the real look-alike request shape and the sub-step rendering.

## 0.1.2

- Maintenance release: identical code and docs to 0.1.0. Published directly because npm staged
  0.1.1 and the registry would not accept an approval for that stage record.

## 0.1.0

First release.

- **Measured occupancy line**: a dynamic runtime-context contribution rendered from
  `tokenMeter.measure(session).totalTokens` (falling back to the `contextPressure`
  projection), with the auto-compaction point derived exactly the way
  `dsh-compaction-basic` derives it. Four bands (ample / moderate / tight / critical)
  with hysteresis, quantized display steps so an unchanged reading never re-injects,
  and a headroom figure that always rounds down — it never promises more room than the
  session has.
- **Compaction directive rules**: the summarizer's trailing directive is extended
  through the public `llm/stream` waterfall (tail-only; the cached prefix is byte-identical)
  so a summary stops carrying the assistant's own guesses about its remaining budget
  forward as established background.
- Zero dependencies, no build step, no tools, no client bundle.
- Bilingual docs: `README.md` (简体中文) and `README-en.md` (English), switched by the
  language line under the title.
- Mounting twice in one scope (bundle assembly plus a runtime injection of the same
  package) leaves the second instance inert instead of failing.
- 21 unit tests: banding, hysteresis, quantization, conservative headroom, degradation on a
  broken meter, directive patching, idempotence, duplicate mounts, and the disabled/interceptor paths.
