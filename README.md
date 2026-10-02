# dsh-context-truth

> 让模型知道自己**真实的**上下文占用——每轮由宿主实测回填，并且不让"上下文快用完了"这句错话被压缩摘要继承下去。

DSH（DeepSeek Harness）插件 · 零依赖 · 零工具 · 零 UI · 免构建 · MIT

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

## 两个能力

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

### 2. 压缩指令补规则（默认开）

压缩摘要调用（`purpose: 'compaction'`）的最后一条消息就是摘要指令。本插件通过**公开的
`llm/stream` 瀑布**在它末尾追加两条规则，只改尾巴、不动被缓存的前缀：

```
- Never record the assistant's own statements about its remaining context, token budget, or
  context-window pressure (for example "context is nearly exhausted", "running out of budget",
  "hand off before context runs out"). Those readings are measured by the host and delivered
  separately; a model's guess about them is not a durable fact.
- Never record a plan to stop, defer, or hand off work whose only justification was context
  pressure. Record the actual task state instead.
```

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
**没有任何依赖、不需要构建**：`lib/index.js` 同时是源码和产物。

## 配置（全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（只关第 1 个能力） |
| `language` | `en` | `en` / `zh` 文案语言 |
| `order` | `100` | 在 runtime-context 里的排序（沙箱 110、审批 115，所以在最前） |
| `quantumPercent` | `5` | 显示台阶（窗口百分比），决定重发频率 |
| `thresholdRatio` | `0.8` | 与 `dsh-compaction-basic` 对齐 |
| `headroomTokens` | `65536` | 同上 |
| `reservedCompletionTokens` | `null` | 默认读路由请求自身的 `maxTokens` |
| `moderateAt` / `tightAt` | `0.5` / `0.85` | 分档边界（相对自动压缩点） |
| `hysteresis` | `0.05` | 降档迟滞 |
| `authoritative` | `true` | 是否附加"本行是唯一权威"那句 |
| `staleClaimClause` | `true` | 是否在 calm 档声明旧说法作废 |
| `logBandChanges` | `true` | 分档变化时写一条 `ctx.logger.info` |
| `patchCompactionPrompt` | `true` | 是否给压缩指令补规则 |
| `compactionRules` | 见上 | 规则数组；`[]` 关闭本能力 |

## 代价（照实说）

runtime-context 快照**字节不变就不会重发**，所以读数按台阶量化。实测（1M 窗口、678K 压缩点、
`quantumPercent: 5`）：

* 一个完整周期（0 → 678K）文字变化 **52 次**，约每 13K tokens 一次；
* 单条占用行 ≈ **124 tokens**，加上同一条快照里其它 section ≈ 250 tokens；
* 合计约占该周期预算 **< 2%**。

换来的是模型不再因为"以为自己快没上下文了"而停手或甩锅。要更省可以调大 `quantumPercent`。

## 兼容性与边界

* 在 **dsh 0.2.0-rc.2** 上实测；只用公开接缝（`systemPrompt.variable/context`、`llm/stream` 瀑布、
  `tokenMeter` / `sessionProjections` 服务），不读私有字段。
* 若某个 agent preset 设置了 `includeRuntimeContext: false`（例如 `liangshen`），运行时会抑制
  **所有** runtime-context 贡献，此时第 1 个能力不生效（第 2 个不受影响）。
* 若宿主把请求信封冻结（本版没有），第 2 个能力会打一条 warn 并跳过，绝不阻断模型调用。
* **同一作用域挂载两次不会失败**：bundle 装配 + 运行时注入是同一插件的两条装配路径，
  第二个实例检测到重名后保持静默（只记一条 info），由第一个实例继续服务——不会变成
  一行 failed 的插件记录。
* 本插件不注册任何工具、不改工具目录，因此不增加首轮 prefill。

## 验证

```sh
npm test          # 19 项单测：分档/迟滞/量化/降级/摘要改写/幂等
```

装好后开一个新会话发一条消息，展开该轮的 runtime context 块应看到
`Context occupancy (host-measured): …`；日志里会有
`context-truth: none -> ample (used=… window=1000000 compactionAt=678464)`。

## 卸载

从 profile patch / bundles 里删掉那一行即可，重启即净——没有工具、没有客户端、没有落盘状态。

## English

**dsh-context-truth** gives a DeepSeek Harness agent the one fact it cannot measure for itself:
how full its context actually is. A single dynamic runtime-context line, rendered from the
host's own token meter (`tokenMeter.measure`), re-injected only when the reading moves a
display step. It also extends the compaction directive — through the public `llm/stream`
waterfall, tail-only so the cached prefix is untouched — so summaries stop carrying the
model's own guesses about its remaining budget forward as established background.

Install: `dsh plugin --profile web add dsh-context-truth`. Zero dependencies, no build step,
no tools, no UI. MIT.

## License

MIT
