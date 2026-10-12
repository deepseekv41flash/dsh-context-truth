# dsh-context-truth

[English](README-en.md) · [简体中文](README.md)

> 让模型知道自己**真实的**上下文占用——每轮由宿主实测回填，并且不让"上下文快用完了"这句错话被压缩摘要继承下去。

DSH（DeepSeek Harness）插件 · 单一 peer 依赖（宿主自带的 `schemastery`）· 需要宿主服务 `tokenMeter` 与 `compaction`（标准部署的 `dsh-base` 自带）· 零工具 · 免构建 · MIT

---

## 它解决什么问题

**DSH 从不把 token 用量告诉模型。** 模型只能靠"这个会话好像很长了"来猜，于是长会话里它会
在真实占用 **17%** 的时候宣布"上下文见底了"，停止写操作、把活儿甩给子代理。

更糟的是这个错判会**跨压缩存活**：

1. 模型自己写下"我的上下文快用尽了"；
2. 这句话进入压缩摘要（实测某会话摘要原文：`- Session budget is nearly exhausted; ...`）；
3. 检查点的固定引导语是 *"Treat the captured context as **established background**"*；
4. 于是每压缩一次，这个错误信念就被当作既定背景重新注入一次——**永远不会因为真实占用回落而被纠正**。

本插件同时掐断这条链的两端。

## 三个能力

### 1. 实测占用回填（默认开）

一条动态 runtime-context，每轮由宿主自己的 token meter 渲染：

```
Context occupancy (host-measured): 300K / 1.00M tokens used (30%). Automatic compaction
fires at 678K (68% of the window). About 378K tokens of headroom remain before it.
There is still real headroom — keep going, and keep durable notes or commits current as
you work. This host-measured line is the only authority on context pressure; never
estimate it from the conversation's length.
```

四档语气（`ample` / `moderate` / `tight` / `critical`）按**自动压缩阈值**的比例分档，
带 5% 迟滞；`ample` 档额外声明"此前所有'上下文快满了'的说法（含压缩检查点里的）都已作废"。
读数不足一个显示台阶时渲染为 `under 50K / 1.00M tokens used (under 5%)`——不会渲染成 `0`，
那会和同一行里的剩余量自相矛盾。

**余量还能撑几步**：`tight` / `critical` 档会把这行余量换算成本会话自己的节奏，例如
`At this session's recent rate that is roughly 6 more steps.`。它是**测出来的**，不是猜的——
每步增量取"步边界之间读数差"的**中位数**，步号来自宿主自己的 `(turn, step)` 计数器。所以
一次 30K 的工具结果拖不动它；而压缩折叠会让读数重锚（实测 200K → 不足 50K，3 秒内），
负增量会**清空历史**、让估算重新累积，绝不与旧基线平均。档位取 `1/2/3/5/8/13/20+` 且**向下取整**
（与余量本身同方向：绝不承诺比真实节奏更多的步数）。顶部是开放档：实测里原始步数在 23~38 之间
摆动、正骑在旧的 `21/34` 边界上，90 秒内让这一行翻了 4 次（其中一次快照重发完全由翻档造成），
而 20 步以上那个精确数字并不改变任何决策。档位另带**单边迟滞**：向下立即生效（少承诺的余量绝不
拖延），向上要超出该档 25%（`paceMargin`）才改口——骑在边界上的估算翻不动它，真正变慢的会话
也不会被永久卡住。它纯属展示——不参与分档、阈值或任何折叠判定；关掉它就是 0.1.3 的行文本。

**`tight` 档默认什么都不说**：这一档只报数字（已用、阈值、剩余量、约合几步），**不加任何收尾句**。
这是被实测逼出来的结论——三种措辞试过：0.1.3 命令"收尾、交接"，0.1.4 陈述"快折叠了，别让关键状态
只留在对话里"，两者都让模型开始在回复里**反复谈论压缩**并降低工作积极性，而 tight 恰恰是重发最
频繁的档（实测该档提交 333 次、间隔中位数 45 秒、成串出现 4~20 秒）。`tightAdvice: 'inform'` 可
恢复 0.1.4 那句，`'stop'` 恢复 0.1.3 的祈使句。

**这行会明说自己是遥测——而且不是一笔可以花掉的预算**：收尾句是"本行是宿主的后台遥测……不要提起它、
不要凭对话长度估计压力、**不要自行倒计时**（读数变化时它会自动重述），也不要对压缩采取任何动作：
**折叠由宿主在步与步之间自动完成**"。后半句同样是被实测逼出来的：模型前几次还抄得准，之后就自己往下
减——`30K → 28K → 16K → 10K → 7K → 5K`——而宿主报的数一直停在 `About 10K`（它只在跨档时重述）。
12 分钟后模型宣布 "Context is nearly exhausted (~5K)"，这个数宿主从未报过。

**这行同时回答"我还剩多少上下文"**：它原先只印"距折叠点的余量"，从没印"窗口还剩多少"。实测里模型
用前者回答了后者——在余量 `Under 10K` 时写下 "Very low context"，而当时**窗口还有 350K 未使用**：
两个数都是真的，但只有一个回答了它的问题。现在每一档都带 `About 300K of the window is still free`，
而且**一个数字都没删**：我们认真考虑过在临近折叠时撤掉余量数字，结论是**不能这么做**——两个端点
（已用量、折叠点）本来就印在行里，模型做一次减法照样能得到，撤掉一个可推导的数字只会在最需要
真值的时刻重建最初那个 bug 的前提（没有基准 → 凭空猜）。它与"已用"共用同一个显示台阶，因此不带来
额外重发；`freeClause: false` 可关闭。

**余量小的两档会定义"折叠是什么"**：光给数字还留着一个缺口，实测里模型正好踩进去——那一行报出
`Under 10K tokens of headroom remain before it` 之后 **11 秒**，模型写下 "Very low context. I must do
this in as few commands as possible, then a short answer."。数字它读对了，但它把"距折叠的余量"理解成
了"剩下的上下文"，而当时窗口还剩 350K、折叠只是把较早的对话换成摘要。所以 `tight` 档补上一句
**定义**（不是指令）："折叠是例行操作，不是窗口的终点：较早的对话会被折成摘要，之后工作照常继续。"
`critical` 档用短版："窗口并未耗尽——折叠之后工作照常继续。" 两句都不含任何动作要求，因此不会退化成
0.1.3 那种"收尾/交接"的催促。`foldClause: false` 可关闭。

**余量档位在临近阈值时保持粗粒度**：早先的实现会在余量变少时把档位缩到 2K，而那正是这一行重发最
频繁的区间，于是几乎每一步都跳一次。现在档位下限是窗口量子的 10%（1M 窗口即 10K）：距阈值只有几
万 tokens 时，"约合几步"才是有效信号，而小于一档的余量仍会如实渲染成 `Under 10K`。从 128K 余量走
到 0，这行的重发次数由 **23 次降到 11 次**。

### 2. 压缩指令补规则（默认开）

压缩摘要调用的最后一条消息就是摘要指令。本插件通过**公开的 `llm/stream` 瀑布**在它末尾追加
两条规则，只改尾巴、不动被缓存的前缀：

```
- Never record the assistant's own statements about its remaining context, token budget, or
  context-window pressure — not even quoted, paraphrased, or listed as an example, and not
  when an earlier checkpoint already carries one: drop that wording instead of copying it
  forward. Those readings are measured by the host and delivered separately; a model's guess
  about them is not a durable fact.
- Never record a plan to stop, defer, or hand off work whose only justification was context
  pressure. Record the actual task state instead.
```

识别依据是调用方打的 `purpose: 'compaction'` 标记；部署没有打标记时，兜底判据要求末尾那条
消息**以指令开头**——所以"只是引用了引擎"的工具结果（源码转储、日志片段、grep 命中）不会被
误改，也不会吃掉那条一次性失败告警。

### 3. 空闲边界折叠（可选，**默认关**；能否工作取决于压缩后端是否对插件可达）

宿主的自动压缩是一个**"跨过阈值"**触发器，而模型在临近阈值时的行为——合并往返、回避高风险改动、
改到一半就提交 WIP——**恰好使读数永远停在阈值下面**。实测一个长会话：

```
4 小时零折叠 · 每轮只有 2~8 步 · 连续三次"继续"仍无法完成同一个任务
读数长期停在 "Under 10K tokens of headroom remain"
```

于是每一轮都从"只剩 2~8 步"开始，需要连续迭代的任务（比如调试一个 500+ 行的 harness）永远收敛不了。
本能力在**模型自己的回合边界**（`agent/status === 'idle'`）折叠一次：读数进入 `foldAtIdleMarginPercent`
（默认窗口的 5%，1M 窗口即 50K）以内时调用官方 `compaction.compactNow()`。官方引擎本来就只允许在
idle 时压缩，所以时机正好。折完余量回到几百 K，条件不再满足 → **一个周期只折一次**。

**默认关**：它要花一次摘要调用并重写窗口，这是策略决定，不是遥测。开关就在设置页（见下）。

## 数据来源（都是宿主的真实数字，没有估算）

| 项目 | 来源 |
|---|---|
| 已用 | `tokenMeter.measure(session).totalTokens` —— 宿主对下一次请求的计价，也是自动压缩实际比较的那个数 |
| 窗口 | `session.requestContext().contextWindow` |
| 兜底 | `contextPressure` 投影（provider 上报的 prompt 侧用量）——**与 Web UI 那个上下文环同源** |
| 自动压缩点 | `min(window × thresholdRatio, window − 保留输出 − headroom)`，与 `dsh-compaction-basic` 同式 |
| 摘要指令 | `llm/stream` 瀑布里 `purpose: 'compaction'` 请求的最后一条消息 |

## 安装

```sh
# npm
dsh plugin --profile web add dsh-context-truth
```

或直接写进 profile 的 patch 层：

```yaml
# <DSH home>/profiles/<profile>/cordis.patch.yml
- insert:
    - id: context-truth
      name: dsh-context-truth
      config:
        language: zh        # 可选：中文文案
```

本包带 `dsh.bundle.patch`，作为 bundle 列进 profile 的 `dsh.profile.bundles` 也会自动装配。
**不需要构建**：`lib/index.js` 同时是源码和产物。

**两项宿主服务是硬依赖**：`inject = ['systemPrompt', 'tokenMeter', 'compaction']`。这不是可选的——
cordis 只把服务接线给**声明了注入**的 context（`provide` 把实现存在提供者的 store 里，同级条目
互相看不见），所以不声明就取不到。两个服务都由 `@deepseek-ai/dsh-base` 挂载（`token-meter`、
`compaction-basic`），标准部署都有；只挂其中之一的定制 profile 下本插件不会加载。

## 配置（全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（只关第 1 个能力） |
| `language` | `en` | `en` / `zh` 文案语言 |
| `order` | `100` | 在 runtime-context 里的排序（沙箱 110、审批 115，所以在最前） |
| `quantumPercent` | `5` | 显示台阶（窗口百分比），决定重发频率 |
| `paceEstimate` | `true` | 是否把余量换算成本会话节奏（`tight`/`critical` 档） |
| `paceSamples` | `16` | 节奏取中位数的样本数（近 N 步增量） |
| `paceMinSamples` | `3` | 少于此样本数不显示估算 |
| `paceMargin` | `0.25` | 向上换档需超出该档的比例（防抖，且不会卡死） |
| `thresholdRatio` | `0.8` | 与 `dsh-compaction-basic` 对齐 |
| `headroomTokens` | `65536` | 同上 |
| `reservedCompletionTokens` | `null` | 默认读路由请求自身的 `maxTokens` |
| `moderateAt` / `tightAt` | `0.5` / `0.85` | 分档边界（相对自动压缩点） |
| `hysteresis` | `0.05` | 降档迟滞 |
| `tightAdvice` | `none` | `tight` 档收尾句：`none` 不加（默认）；`inform` 陈述后果；`stop` 用 0.1.3 的命令式 |
| `authoritative` | `true` | 是否附加"本行是唯一权威"那句 |
| `staleClaimClause` | `true` | 是否在 calm 档声明旧说法作废 |
| `foldClause` | `true` | 是否在 `tight`/`critical` 档定义"折叠是什么" |
| `freeClause` | `true` | 是否报告"窗口还剩多少未使用" |
| `logBandChanges` | `true` | 分档变化时写一条 `ctx.logger.info` |
| `patchCompactionPrompt` | `true` | 是否给压缩指令补规则 |
| `compactionRules` | 见上 | 规则数组；`[]` 关闭本能力 |
| `foldAtIdle` | `false` | 是否启用第 3 个能力（空闲边界折叠） |
| `foldAtIdleMarginPercent` | `5` | 余量 ≤ 窗口的百分之几时触发（1M 窗口 = 50K） |
| `foldAtIdleMethod` | `auto` | 折叠请求通道：`auto`＝先走该会话的 `/compact`（realm 视图，原版可用）再回退服务；`command`／`service` 强制其一 |
| `foldAtIdleCooldownMs` | `60000` | 两次尝试之间的最小间隔（失败也不会反复撞引擎） |

**配置写在 profile patch 里**（`subagent` 的 `maxDepth`、`bash-terminal` 的 `defaultShell` 都是这样生效的）：

```yaml
- id: context-truth            # 与 bundle patch 里的行 id 相同
  name: dsh-context-truth
  config:
    foldAtIdle: true
    foldAtIdleMarginPercent: 5
```

改动**立即生效**：宿主的 volatile 机制把新值直接写进运行中的配置引用（`loader._commitVolatile`），
不重载插件；插件因此每次使用时才解析选项，而不是挂载时快照。实测：改完 patch 无需重启，运行中的
`foldAtIdle` 立刻变成 `true`。

> ⚠️ **这个 DSH 版本没有"按 schema 自动生成插件设置表单"的机制。** 官方插件（`subagent`、
> `bash-terminal`/shell、`agent-loop`、`web-search`）的设置界面都是**各自客户端包手写的卡片**
> （按条目 id 注册进 `plugins.item` 插槽），通用的 `plugins.row.config` 插槽**全应用无人注册**。
> 插件导出 Schemastery `Config` 会让宿主注册这个命名空间（实测 `ns=context-truth`、`applies=live`），
> 但**没有任何 UI 会渲染第三方插件的通用表单**——所以开关落在 profile patch 里。
>
> 想要一个真正的设置页面开关，就得给插件写一个**客户端卡片包**（照
> `@deepseek-ai/dsh-client-ui-settings-subagent` 的样子：注册 `plugins.item` 插槽 + 一个绑定
> settings 表单的 `z.boolean()` 控件）。宿主不会自动生成它。

`enabled`（总开关）用**插件列表里的开关**即可——那一个会重载插件。

## 代价（照实说）

runtime-context 快照**字节不变就不会重发**，所以读数按台阶量化。实测（1M 窗口、678K 压缩点、
`quantumPercent: 5`）：

* 一个完整周期（0 → 678K）文字变化 **52 次**，约每 13K tokens 一次；
* 单条占用行 ≈ **124 tokens**，加上同一条快照里其它 section ≈ 250 tokens；
* 合计约占该周期预算 **< 2%**。

换来的是模型不再因为"以为自己快没上下文了"而停手或甩锅。要更省可以调大 `quantumPercent`。

## 兼容性与边界

* 在 **dsh 0.2.0-rc.2** 上实测；只用公开接缝（`systemPrompt.variable/context`、`llm/stream` 瀑布、
  `tokenMeter` / `sessionProjections` 服务）。唯一例外：节奏估算读宿主的 `agent.phase.{turn,step}`
  实例字段（未文档化）——拿不到时该子句**整段不出现**，行文本退回 0.1.3 的样子，绝不猜一个数。
* 若某个 agent preset 设置了 `includeRuntimeContext: false`（例如 `liangshen`），运行时会抑制
  **所有** runtime-context 贡献，此时第 1 个能力不生效（第 2 个不受影响）。
* 若宿主把请求信封冻结（**本版没有**——已通过抓取真实压缩请求验证），第 2 个能力会打一条
  warn 并跳过，绝不阻断模型调用。该告警只为引擎自己打了标记的调用保留，误报的"形似请求"
  不可能吃掉它、让后面真失败变成静默。
* **同一作用域挂载两次不会失败**：bundle 装配 + 运行时注入是同一插件的两条装配路径，
  第二个实例检测到重名后保持静默（只记一条 info），由第一个实例继续服务——不会变成
  一行 failed 的插件记录。
* 本插件不注册任何工具、不改工具目录，因此不增加首轮 prefill。

## 验证

```sh
npm test          # 51 项单测：分档/迟滞/量化/自由窗口/折叠定义/空闲折叠与护栏/配置热更新/schema 默认值一致性/节奏估算/降级/摘要改写/形似请求排除/幂等
```

装好后开一个新会话发一条消息，展开该轮的 runtime context 块应看到
`Context occupancy (host-measured): …`；日志里会有
`context-truth: none -> ample (used=… window=1000000 compactionAt=678464)`。

## 卸载

从 profile patch / bundles 里删掉那一行即可，重启即净——没有工具、没有客户端、没有落盘状态。

## License

MIT
