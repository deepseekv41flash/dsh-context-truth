# Changelog

## 0.3.2

* **注入行按模式说明真正的触发点。** 以前三种模式都只说"宿主自动压缩点 X"——在 `handoff` 下这是错的
  引导：模型看到 727K 会认为交接档可以晚点写。现在：
  - `off`：只给宿主点（与旧输出逐字一致）；
  - `idle`：追加"本插件会在你的回合边界、余量进入 N（窗口的 foldAtIdleMarginPercent%）以内时折叠"；
  - `handoff`：追加"占用到 N（折叠点的 handoffAt%）时会提醒你写交接档，折叠在那一轮结束时执行"。
  三者都保留宿主点作为兜底。中英文都覆盖。
* README 顶部加 npm / license 徽章，顺序与 `dsh-multi-shell`、`dsh-superagent-panel` 一致
  （标题 → 语言切换 → listed/npm/license 三枚徽章 → 摘要）。
* **准备提醒改走 runtime context，不再是一条用户消息。** `agent/request` 里只发布一段待渲染的提醒，
  由本插件已经注册的 `systemPrompt` 动态上下文段（`{{...}}` 变量）在**同一个请求**里渲染成
  `<system-reminder>` 快照；下一个请求先退役它再决策，所以仍然是“每轮最多一次”。
  - 时序更早：`agent/request` 在同一步的上下文刷新之前触发，不必等下一次请求（`agent.inject` 是排队）。
  - 不再伪装成用户发言：`source.kind` 是 `runtime-context` 而不是 `user`，对话里不留气泡。
  - 轮末唤醒仍然用 `followup`：动态上下文只有在真的发生请求时才会被读到，唤醒必须开一轮。
* 测试：72（新增“实时切模式后提醒随模式消失”用例；三处变异分别失败 3 / 4 / 5 例）。

## 0.3.1

* **`handoff_ready` 只在 `handoff` 模式下注册。** `off` / `idle` 下它从工具目录里移除（用
  `tools.register()` 返回的注销 disposer），切回 handoff 时在**下一个请求**重新注册；插件被销毁时
  也会注销。`off` / `idle` 的工具目录与没有这个能力时完全一致，不再为首轮 prefill 承担一个
  永远只会拒绝的工具定义。
* 日志分别记 `handoff_ready registered (fold mode is handoff)` /
  `handoff_ready removed (fold mode is <mode>)`，模式切换在日志里可见。
* 测试：70（新增“工具跟随实时模式”用例；变异“去掉注销调用”恰好只让它失败，恢复后字节一致）。

## 0.3.0

> **新增能力 3 的第二形态：交接式折叠（`foldMode: handoff`，实验性）。** 默认模式改为 `idle`
> （即本插件此前的空闲边界折叠）。详细的背景、实测与护栏见 README 的「交接式折叠」一节。

### 新增

* **`handoff` 折叠模式（实验性）**：读数到达准备点（`handoffAt` × 折叠点，默认 85%）时注入提醒，
  给出唯一允许的交接档路径（`$DSH_HOME/handoffs/<sessionId>/<fold#>.handoff.md`，绝不进工作区）；
  模型写完档后调用新工具 `handoff_ready` 登记；该轮结束时插件真正调用 `compactNow()`；折叠后
  `followup` **只激活一轮**，第一条指令就是先读档再继续。基线：143 次折叠里 81 次（57%）在折叠后
  重新读取了自己刚写过的文件，合计 225 次——这个机制针对的就是这部分重复劳动。
* **设置卡**（`lib/client.js` + `package.json` 的 `dsh.client` / `exports["./client"]`）：在插件页
  注册 `plugins.bundle.config`（key = 包名），渲染“折叠模式”下拉框，读写走
  `settings.describe()` / `settings.mutate()`。DSH 不会按 `Config` schema 自动生成插件设置表单，
  没有这张卡时只能改 profile patch。
* 工具 `handoff_ready` 在所有模式下都注册（设置卡需要能随时切换模式），只在 `handoff` 模式下生效。

### 变更

* **默认模式改为 `idle`**：没写过 `foldMode` 的配置按 `idle` 解析（它就是此前的行为，当时由
  `foldAtIdle: true` 打开）；显式 `foldAtIdle: false` 仍解析为 `off`，不会被这次改默认值带走。
* **模式切换立即生效**：`foldMode` 是 volatile 配置，设置卡写进运行中的引用，插件每次调用重新解析
  选项。实测：面板切到 `handoff` 后，运行中的实例在下一次调用就按 handoff 执行（`handoff_ready`
  直接给出了本会话的交接档路径，而不是“不在 handoff 模式”的拒绝）。切换本身不会触发折叠。
* README/README-en：更正“不注册工具”“无客户端”“无落盘状态”等已过时的表述，补上工具、设置卡、
  handoff 状态文件与实验性标签。

### 修复（均来自实机演练）

* **回收不再删掉激活目标**：准备轮 N+1 发生在激活轮 N 里，旧实现会把 fold N 的交接档当旧档删掉，
  激活轮第一条 `read` 得到 `FS_NOT_FOUND`（实测时间线：激活 18:39:58.877 → 回收 18:40:03.431 →
  读档 18:40:04.983）。现在按编号保留当前折叠的档。
* **提醒不再等人开口**：`agent.inject` 只排进下一次请求；提醒落在模型最后一步时，会话空闲后
  要等人类发消息才会被读到（实测：18:48:04.482 注入，直到人发消息才出现）。现在轮末若已过准备点
  且没登记，会用 `followup` 唤醒一轮把提醒送到，次数计入同一份提醒预算。
* **唤醒轮不再叠第二条提醒**：唤醒时把该轮记为“已提醒”，同一轮后续 step 不再注入。
* **`handoff prep` 日志的数值**：之前打印的是准备点却写成 “fold point”，现在打印真正的折叠点。

### 验证

* `npm run check` 通过；`npm test` **69/69**。
* 变异测试：去掉“保留当前折叠档”的判定 → 3 条测试失败；把轮末 `followup` 改成 `inject` → 1 条失败；
  去掉唤醒轮的“已提醒”标记 → 1 条失败；每次恢复后按字节比对一致。
* 实机：准备提醒 → 写档 → 登记 → 轮末真实折叠（`folded … at the round end via service (fold #1)`）
  → 插件自行激活唯一一轮 → 激活轮首条动作是读档。

## 0.2.0

> **能力 3（空闲边界折叠）能否工作，取决于接缝对插件是否可达——而"可达"取决于挂载组合，不是
> "官方 vs 第三方"。**（这一节先后写错过两次，以下是 2026-10-12 的实测版。）
>
> 最终设计的三条，都是实测逼出来的：
> 1. **`inject` 只声明 `['systemPrompt','tokenMeter']`。** 声明 `compaction` 会让条目**永久
>    pending**——插件完全不加载，第 1 个能力的占用行也一起消失。已向上游报告
>    [deepseek-harness#9425](https://github.com/deepseek-ai/deepseek-harness/discussions/9425)。
> 2. **服务按候选链解析，不用 `ctx.get`**：`agent.ctx` → `ctx` → 已接线服务，取第一个**真的带
>    `compactNow`** 的（不是"第一个不是 undefined 的"——对一个本 fiber 没有的服务做属性读取会返回
>    **诊断字符串**，早期版本把那个字符串当成"找到了"，于是引擎一直可达、折叠却永不触发）。
> 3. **启动那行诊断只反映插件自身 ctx 的可见性**，不能用来判断折叠能否工作：本 profile 现在打印的
>    正是 `compaction=undefined/none`，而折叠在 2026-10-12 成功跑了两次。
>
> 实测（本 profile：`dsh-dcp` **禁用**，profile patch 末尾重新启用官方
> `@deepseek-ai/dsh-compaction-basic`）：
> - 2026-10-12 **16:07** 与 **21:46** 两次**自动**空闲折叠均成功，日志为
>   `folded at idle via service (headroom=46558 margin=50000)` / `(headroom=43789 …)`；触发都落在
>   回合边界上（`turn/end` 之后 13–30 毫秒），占用分别从 631K / 634K 降到 178K / 205K。
> - 服务通道解析到的就是官方引擎，**它会真的调用 LLM 摘要**：21:46 那次用量为输入 600 +
>   缓存命中 633,600 + 输出 3,743（命中 **99.9%**，折叠区域 432,321 token，墙钟 21 秒）。
> - 因此 dcp 时代的结论（"官方不可达、只有 dcp 可达"）**作废**：那是在官方后端被 dcp 的 bundle
>   patch 整个禁用的配置下测的——引擎压根没有挂载。
>
> **折叠请求有两条通道（`foldAtIdleMethod`）**：
> 1. **命令通道**：`ctx.commands.execute(agent, '/compact', [], signal)` —— 走**该 agent 的 realm
>    视图**，因此落到该会话本该用的那个后端上（与人类敲 `/compact` 完全一致），折叠风格与会话自身一致。
> 2. **服务通道**：候选链里第一个带 `compactNow` 的实现，也是 realm 没注册 `compact` 命令时唯一的
>    办法。本 profile 显式选 `service`（最可预测），实测可用。
> 命令通道失败（realm 无该命令、或拒绝）会**自动回退**到服务通道；两者都不通时只记一次说明日志。
>
> **与 dsh-dcp 的分工（若你挂它）**：它的轮数触发（`roundInterval`，默认每 50 条 assistant message、
> 在空闲边界）是**活动驱动**的，本插件是**压力驱动**的（余量进入窗口 5%、在同一个空闲边界执行）；
> 任何一次折叠都会重置它的轮数时钟，所以两者不会互相打转。本 profile 已禁用它，配置与回退配方见
> profile patch 注释。
>
> **dsh-dcp 的"关掉官方后端 + 接管接缝"只作用于它自己所在的那一层**（我们一开始也写错了）：
> 每个 agent preset 里还有一个 `cordis:group` realm，里面**各自挂着一份** `compaction-basic` +
> `command-compact`。所以同一进程里可能同时存在两个后端——这也正是那个坑的来源：**只关 dcp 而不
> 重开官方 = 零后端；只开 dcp 而不删重开行 = 双后端同时注册 `compaction`。改它们必须成对。**

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
- **The wiring went through three designs; the first two are recorded here because their failure modes
  are the trap.** (1) `ctx.get('compaction')` returned nothing — a service is not reached that way, and
  the occupancy line had been quietly surviving on the `contextPressure` projection fallback. (2)
  `ctx.inject(['compaction'], cb)` never ran its callback, and **declaring `compaction` in `inject`
  left the entry pending forever** — the plugin did not load at all, taking capability 1 with it.
  (3) the shipped design: `inject` stays `['systemPrompt','tokenMeter']`, and the fold resolves the
  service through a **ranked candidate chain** (`agent.ctx` → `ctx` → wired service), taking the first
  candidate that **actually carries `compactNow`** — never "the first that is not undefined", because
  a property read for a service this fiber does not have answers with a **diagnostic string**. Services
  are resolved **per use**, never snapshotted, and a one-line startup diagnostic reports what the
  plugin's own context can see. Measured 2026-10-12: two automatic idle folds resolved the official
  engine through that chain and completed (16:07 and 21:46) while the startup line printed
  `compaction=undefined/none` — so the diagnostic is not a readiness check for capability 3.
- **Capability 2 rides the seam, byte-for-byte.** Captured on both 2026-10-12 folds: the trailing
  directive on the wire is the patched one — **2,336 characters** (1,802 original + 534 of rules), all
  three rule markers present, and the request lands **19 ms** after `compaction-cache: aligned` logs the
  same call (21:46:08.085 / .104) — two plugins cross-validating each other on the same `llm/stream`
  waterfall. The patched trailing message is **not frozen** (the plugin replaces the array slot, so the
  engine's `deepFreeze` on the appended message does not apply). Cost: **+534 characters ≈ +134 tokens
  (+0.09%)**, appended *after* the cached prefix, so that is the only fresh full-price input a fold adds.
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
