# Changelog

## 0.4.2

* **激活说明改走 runtime context：不再被"目标续跑"或别的会话开的轮次挤掉。** 现场（session-c5d0874b，
  2026-11-24）：折叠 23:16:04 结束；同一秒目标续跑（`source.kind: "goal"`，`<goal_round>`）开了新轮；
  而携带激活说明的 `followup` 直到 23:17:22 才落进那一轮——**晚 78 秒**，排在 Objective 之后，读起来只是脚注。
  模型在 23:16:12 自己读了档，但那不是执行我们的指令，纯属运气。
* 改法（`deliver()`）：折叠一结束就先把完整说明发布到 `context-truth:handoff` 运行期上下文块，
  **再由 `followup` 只带一行入口**（路径 + "唯一一次自动激活" + 指向本轮的块）。这样子：
  - 下一个请求无论谁开的（我们的唤醒轮 / 目标续跑 / 另一个会话的 `session_call`），第一个请求的快照里就有说明；
  - 说明里加了一句让步："如果这一轮不是你打开的（例如目标续跑，或另一个会话发来的消息），顺序不变：先读档，再执行那些指令"；
  - 当没有别的驱动者时，唤醒消息仍然把轮次开起来（否则真的空闲的会话不会产生请求，块永远没人渲染）。
* 测试：86（新增 1 条：折叠后、任何新请求之前块已在通道里；唤醒消息不得重复整段清单；块渲染一次即退役）。
  三处变异（不发布块 / 唤醒消息又抄整段 / 删掉让步句）各失败 1 例，隔离副本按字节恢复。
* **实机演练通过（2026-11-25 01:11–01:12，重启后 0.4.2）**：把 `thresholdRatio` 压到 0.02、`handoffAt` 0.5、
  预算 1，用 `session-9deb01b8` 跑同一套流程。时间线：01:11:31.936 登记（4133 字符）→ 01:11:56.612 折叠完成
  → 01:11:56.622 激活（块发布 + 唤醒发送）→ **01:12:02 同一个请求里**同时出现
  `[user]` 的 **355 字节唤醒单行**（"Folded (fold #1 …): read the handoff note before continuing" + 路径）
  与 `[runtime-context]` 的 **3207 字节激活块**（完整清单 + "如果这一轮不是你打开的"让步句）。
  也就是说：块在折叠结束那一刻就入通道，谁开的下一轮都会在它的第一个请求里读到；唤醒消息不再承担说明职责。
  `state.json` 落成 `foldNo: 1`、`pending.deliveredAt` 非空。演练后配置已还原（727K / 服务通道 / 预算 3）。

## 0.4.1

* **修 `handoff` 模式折叠后从不激活轮次：命令通道读错了宿主的返回值形状。** 现场（Linux，stock 部署，
  realm 里没有可注入的 `compaction` 服务，命令通道是唯一能折的路）：`/compact` 真的折了 1295 条 /
  ~506,473 tokens，`command/done` 明确 `{kind: "success", sourceEventSeq: 3436}`，但会话停在 idle，
  **没有激活轮**，`state.json` 停在 `foldNo: 0 / ready 未消费 / pending: null`。
  根因：`dsh-commands` 的 `settle()` 返回 `Object.freeze({ commandId, result })`（类型 `CommandExecution`），
  `sourceEventSeq` 在 `result` 里；`requestFold()` 直接读 `execution.sourceEventSeq`，恒为 `undefined`，
  于是每次成功折叠都被判成"没有可折叠范围"（`folded: false`）→ 不记 `foldNo`、不建 `pending`、不 `followup`。
* 一处修三件事（`requestFold` 的命令分支）：
  1. 解包 `execution.result`（新增 `commandResultOf()`，同时兼容直接返回 `CommandResult` 的桩/老宿主）；
  2. `execute()` 对"命令未注册"是 **resolve `undefined`**，不是 throw（`dsh-commands`：
     `if (parsed === void 0) return void 0`），而旧代码只在 catch 里回退服务通道 → 文档承诺的
     "先命令、再服务"在没有 `/compact` 的 realm 上是死的；现在 `undefined` 明确走回退并记日志，
     `foldAtIdleMethod: command` 时则记"不允许其它通道"；
  3. `kind: error` / `cancelled` 的拒绝与"没有可折叠范围"分开记日志（带 `kind` 与原文）；折叠未提交时，
     消费者按 `error` 记 `warn`、其余记 `info`，并写明 `reason`。
* **为什么过去的演练没抓到**：本仓库 profile 用 `foldAtIdleMethod: service`，0.3.x 的激活演练全部走服务通道
  （判定只需 `compactNow()` 非 null，天然正确）。命令分支是 0.3.0（`e3318ab`）引入的，而 `dsh-commands`
  从 0.2.0-rc.2 起就是两层形状 —— **命令分支上线第一天起判定就恒为 false**，只是从没人走过这条路。
  这次把"命令通道也必须激活"变成回归用例，不再依赖演练选哪条通道。
* 测试：85（新增 3 条：真实两层契约必须激活；`execute` resolve `undefined` 必须回退服务并激活；
  `kind: error` 必须保留档、不激活、记 `warn`）。三处变异分别失败 2 / 1 / 1 例，隔离副本按字节恢复。
* 顺带更正 `thresholdRatio` 的注释：原文把 0.7 写成"本 profile 跑 dsh-dcp"的事实，而现场那台机器并没有该包；
  改为说明 0.7 是 dsh-dcp 的取值、stock 是 0.8，应按实际挂载的引擎设置。
* ⚠ 命令通道的实机验收要等重启（HMR 缺陷 #13623 让 link 插件的源码改动只能靠重启生效）；本机待做，
  现场（Linux）需 `npm i dsh-context-truth@0.4.1` 后重启复验 `foldNo: 1` + 激活轮。

## 0.4.0

* **委派会话（子代理）也能写交接档了：`subagentHandoff`，默认关。** 动机是量出来的，不是猜的：
  上游把"智能体团队"并进子代理之后，子代理成了可续、可寻址的同事（#7519 的身份与消息指引、
  0.2.2 的命名、`continue its conversation after it finishes`），生命周期变长，折叠暴露面跟着上升。
  本机 296 个会话里 116 个是子代理，**8 个（6.9%）至少折叠过一次**（14 次折叠事件），其中一个已经
  到折叠点的 65%。而折叠对子会话的伤害和根会话一样大：它的父代理会继续用 `send_message` 找它，
  好像它还记得折叠前的事。
* 形状是**提醒 + 写档 + 折叠后指回**，**不唤醒、不折叠**：
  - 委派会话越过准备点（`handoffAt` × 折叠点，默认 85%）时，把 `[handoff fold · subagent prepare]`
    发布到它自己的 `context-truth:handoff` runtime-context 块（与根会话同一条通道，仍然每轮最多一次、
    每周期最多 `handoffReminders` 次，没有用户消息、没有 `inject`）；
  - **写文件就是登记**：子会话的工具目录里没有可用的 `handoff_ready`（它按设计拒答委派会话），
    所以插件在下一个请求里检查 `<root>/<childSessionId>/<fold#>.handoff.md` 是否存在，存在即登记，
    并记下当时读数作为折叠基线；开关打开时 `handoff_ready` 的拒答文案改成"写文件本身就是登记"，
    不再是一堵墙；
  - 折叠由**宿主**在压力点执行，插件只观察：已登记 + 读数掉到登记时读数的 **90% 以下** = 折叠发生了
    （读数只在窗口被重写时掉下来；掉几个百分点是工具目录进出之类的抖动，不算），于是把
    `[handoff fold · subagent, after the fold]` 连同路径发布到下一次请求，`foldNo` 加一（下一份是
    `002.handoff.md`），并保留被指回的那份档——与根会话"激活目标不能被下一轮准备回收"同一条规则；
  - 掉档但没折叠（例如重启后才发现档、或读数在准备点以下且有旧档）也有归宿：`discoveredLate`
    直接发指回提示，不让子会话困在"档在盘上、没人告诉它"的状态里。
* 默认关：它会改变每个子会话模型看到的东西，而多数子会话到不了准备点（116 个里只有 8 个被折叠过）。
* **实机演练通过（2026-11-20 20:00，重启后运行 0.4.0 + `subagentHandoff: true`）**：把 `thresholdRatio`
  压到 0.02（折叠点 20,971、准备点 17,825）、`handoffReminders` 压到 1，用一个既有子会话跑完整条链路：
  1. `delegate handoff prep 1/1 … (used=93604 of the 20971 fold point)` —— 提醒发布；
  2. 子会话按提醒写 `handoffs/86942830…/001.handoff.md`（2318 字符），**没有**调 `handoff_ready`
     （其拒答文案也确实换成了"写文件本身就是登记"那句）；
  3. `delegate … wrote its handoff note (2318 chars)` —— 文件即登记，`ready.used=100865` 基线入账；
  4. 把基线改成 600,000 模拟宿主折叠（真折叠要 727K，演练压不到），下一次请求得到
     `delegate … was folded since it wrote …`，`foldNo` 0→1、`ready` 清空、`reminders` 归零；
  5. 子会话的下一次请求逐字报回 `[handoff fold · subagent, after the fold]` 首行与路径。
  全程没有 `followup`、没有折叠（该子会话的每一次被唤醒都来自父代理的 `send_message`）。
* **真实宿主折叠也补上了（同日 20:13–20:14，生产会话而非演练）**：另一个会话里已有的子代理
  `f664ed48`（当时 65%）拿到提醒是 20:10:10.816 `delegate handoff prep 1/3 (used=683623 of 727040)`，
  它写了 5,594 字符的档（基线 `ready.used=691627`）；读数在 20:13:36.158 越过折叠点
  （`tight -> critical (used=727843 … compactionAt=727040)`，超出 803 tokens），宿主随即折叠
  （`compaction/start` 20:13:36 → `compaction/end` 20:14:00，`compaction (step pressure): shadowed 427
  surface nodes (seqs 12-1189, ~339405 tokens)`）；20:14:00.241 插件判折叠并登记
  `used=392118, registered at=691627, cause=reading dropped`；20:14:09 那条指回提示只投递一次，
  **子会话折叠后的第一个动作就是 `read` 自己的档**（20:14:10），随后在同一轮里继续干活——没有唤醒。
  这是该子会话的第一次折叠（此前 0 次），也是本能力唯一一次"提醒 → 写档 → 真实折叠 → 指回 → 读档"全真链路。
* **顺带纠正一条 0.3.2 写错的时序**：runtime context 快照是在该步的 `agent/request` 瀑布**之前**物化的，
  所以"在这条瀑布里发布的提醒由同一个请求渲染"是错的——它由**下一个**请求渲染（证据：19:50:08.943 发布，
  19:50:11 的快照才带上它）。多步轮次不受影响；对"一轮只有一步"的子会话意味着轮末发布的折叠后标记要等
  父代理下一次叫它才读得到（演练里正是这样读到的）。代码注释已按实测改写。
* 测试：82（新增 8 条委派用例）；六处变异分别失败 1 / 1 / 2 / 1 / 3 / 3 例，隔离副本按字节恢复后
  与工作副本 sha256 一致。
* 顺带核实（写进交接档，不进代码）：本机 kernel **0.2.2-rc.5 不含** #8348 的子代理汇报指引
  （`dsh-tool-subagent-control` 的 `src/index.ts` 与 `lib/index.js` 都没有那句），它只在 master 上；
  所以"子代理用完 send_message 汇报"这条在本机尚未生效，本机的复用压力来自 #7519 + 命名 + 本地
  `dsh-srkit` 的 `subagent-reuse` skill。

## 0.3.4

* **唤醒消息瘦身：完整提醒改由唤醒轮的 runtime context 承载。** 以前轮末唤醒把整段
  `[handoff fold · prepare]` 塞进一条用户消息（实测 session-36125d3f…：最后一次请求时读数还没越过
  准备点 617,984，轮次结束后涨到 619,646 才越过，于是 prepare 通道没机会发，只有唤醒通道发了整段文案）。
  现在：
  - 唤醒消息只有一行 `[handoff fold · wake]`，点明“本轮结束时会折叠”和唯一允许的交接档路径；
  - `prepare` 在唤醒轮的**同一个请求**里重新发布完整提醒到 `context-truth:handoff` 块，清单不再以用户
    消息形式出现；
  - 若唤醒轮开始时读数已回落到准备点以下（宿主先折了等），只保留那一行，并记一条
    “wake round … is below the prep point now”日志说明原因。
* 测试：74（新增“唤醒轮读数已回落时只留一行”用例；三处变异分别失败 1 / 2 / 1 例后逐字节恢复）。
* **实机演练（2026-11-17 23:48）**：临时把准备点压到 178K、预算提到 5，轮末真实唤醒一次——日志
  `handoff reminder 5/5 … woke the round`（15:48:14）与 `wake round … published the handoff reminder in
  runtime context`（15:48:21）成对出现；会话里那条唤醒消息只有一行且含路径，完整清单出现在同一轮的
  `context-truth:handoff` 块里。演练未写档，因此没有折叠；演练后配置已还原（thresholdRatio 0.8、预算 3）。

## 0.3.3

* **README 记入权限模型带来的限制。** 交接档在 `$DSH_HOME/handoffs/…`，而模型的文件写入受会话权限沙箱约束
  （`@deepseek-ai/dsh-fs-sandbox` 的 `checkedTarget`）：
  - `read-only`：拒绝一切写入，模型写不了档，handoff 退化为“只提醒、折不了”，最后由宿主压力折叠接管；
  - `workspace-write`：只允许写进会话工作区与系统临时目录，因此仅当工作区是 `$DSH_HOME` 的祖先时交接档才写得进去，
    工作区在别处会被 `FS_SANDBOX_DENIED` 拒绝，插件按预算重试后交给宿主；
  - 两个规避：`handoffDir` 指向工作区内的绝对路径，或指向 `%TEMP%` 下的目录。
  - 另记一条独立门槛：**自动审查（`auto` 预设 = `danger-full-access` + `ask`）下写档会被审查模型判为 medium**
    并通常拒绝（medium 要求“当前用户或直接父级明确授权”，而写档指令来自插件注入的 runtime context）；
    `ask` 下转为一次人工审批，`never` 下终局失败。注册窄写根对该模式无效。
  - 推荐统一规避：`handoffDir` = `<工作区>/.dsh-handoffs`（工作区内写入在两种受限模式下都算项目内写入，
    自动审查判 low、必须放行），并加进 `.gitignore`。
  中英 README 各一节，未改代码。

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
  由本插件注册的**独立**上下文块 `context-truth:handoff`（`order` = 占用行 + 1，自己的 `{{...}}`
  变量）在**同一个请求**里渲染成 `<system-reminder>` 快照；下一个请求先退役它再决策，所以仍然是
  “每轮最多一次”。没有提醒时该变量渲染成空串，宿主会整段过滤掉，快照与以前逐字相同。
  - 时序更早：`agent/request` 在同一步的上下文刷新之前触发，不必等下一次请求（`agent.inject` 是排队）。
  - 不再伪装成用户发言：`source.kind` 是 `runtime-context` 而不是 `user`，对话里不留气泡。
  - 轮末唤醒仍然用 `followup`：动态上下文只有在真的发生请求时才会被读到，唤醒必须开一轮。
* 测试：73（新增“提醒是独立块 / 占用行不被污染 / off 与 idle 不渲染该块”与“实时切模式”用例；
  三处变异分别失败 3 / 4 / 5 例，独立块的两处变异分别失败 1 / 6 例）。

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
