# DeepSeek Harness 记忆与任务插件技术核验

核验日期：2026-11-11。本文为 Memory_FrameWork 的迁移设计提供官方接口与设计依据，记录事实、限制和建议；没有改动插件运行代码，也没有在用户当前 DSH 运行时执行兼容性测试。

## 结论

可行路线是把 Memory_FrameWork 拆成原生 DSH Host Adapter、独立记忆与任务模块、原生 React 管理面板。官方已有会话日志、每步扩展点、动态上下文、工具、工作区注册表和单会话 Goal，足以接入；跨会话任务、可控广播、检索权重与证据治理仍需插件实现。不能把研究原型的功能等同于产品现成功能，也不能把事件发射等同于跨进程一致性。

## 官方来源与版本

- [DeepSeek 官方 Harness 入口](https://www.deepseek.com/harness/zh/) 指向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。官方文档站为 [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)。未将社区教程站当作规范。
- 本次读取的 Harness `master` [package.json](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json) 标为 `0.2.2-rc.1`，Node 要求 `>=24.9.0`。这只是核验时上游源码状态，不代表用户已安装版本。
- [官方 Super-agent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 [package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/package.json) 声明 `engines.dsh: ^0.2.1-alpha.2`，Node `^22.19.0 || >=24.0.0`。这与本次 Harness master 基线不同。实现前需记录实际 CLI/Desktop 版本并锁定兼容的 SDK 和编译链，不能直接拼装不同版本示例。

## 指定 B 站文章及原型的适用范围

已读取用户指定的 [《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://www.bilibili.com/opus/1265361021143351318)，作者为认证账号 DeepSeekHarness，文章标注 2026-10-31。普通网页阅读工具不可访问，但只读 HTTP 正文与 [B 站动态接口](https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=1265361021143351318) 成功返回。文章开头说明这是工程架构探索，不是现有产品功能介绍。

可借鉴的路线：Router 负责跨任务协调，Worker 隔离执行；Trigger 按 Thread 订阅直通；上下文用 Inline & Spill 保留摘要与续读引用；对象以稳定 ID 形成引用图以链式召回；持久状态独立于计算与执行环境；外部 Watchdog 检查实质进展。文章同时承认跨月记忆仍是瓶颈。实验用模拟编码工作测调度协作，不能据此推导本插件的任务准确率或幻觉降低幅度。上述内容分别见文章第 2、3、5、6、7、8 节。

文章没有提供记忆权重公式或记忆广播面板规范。项目管理形态和共享隔离边界被列为开放问题。插件应借鉴其组织方式，另外实现可审计的任务与记忆控制。

文章链接的 [dsh-superagent-prototype README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) 明确：它是研究参考代码，不是正式 DeepSeek 产品，公开版本与内部实现及文章并不完全一致。

原型实际提供：

| 设计 | 已核验的原型行为 | 本插件借鉴方式 |
| --- | --- | --- |
| 独立任务 | Ticket 独立于 Executor Session；Assignment 表示一次执行绑定 | 让 Task/Ticket 成为跨窗口任务权威，窗口和模型执行可以替换 |
| 订阅 | Ticket 与 Thread 多对多，context-only 订阅不授予行动权 | 分离“可读取”“订阅更新”“可以执行”的规则 |
| 幂等 | Trigger 不可变，重复接受同一 Trigger 不创建两个 Ticket | 使用宿主事件身份与序号幂等采集 |
| 引用式召回 | `orchestrator_read` 可从 Ticket 读取 Thread、Trigger、Assignment 等，带分页与有限预览 | 让每条摘要携带原文和相关对象的可续读 ID |
| 面板 | Overview、Source、Trigger、Eval、Execution、Settings | 借鉴任务监督与历史解释，新增广播策略和权重实验页 |

来源：[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[执行过程](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)、[面板](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md)、[实现架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)。建议选取设计和经过评审的实现，首版无需依赖整个 Super-agent 原型。

原型把“订阅获得上下文”和“Mandate 授予行动范围”分开，其中订阅扇出不重新检查发件人。该设计不能直接变成本插件的跨工作区读取授权。本插件仍须在检索前、证据展开时和注入前执行独立的数据读取 ACL；订阅只决定哪些更新值得通知，不扩大接收者本来可读的记忆范围。

## 真实的 DSH 扩展接口

| 目标 | 已核实的接口或机制 | 关键限制 |
| --- | --- | --- |
| Host 插件 | `apply(ctx, config)`、`inject`、`Config`；Cordis effect 生命周期 | 必需依赖未就绪会保持 pending；卸载与重载必须释放资源 |
| 插件分发 | npm 包和 `dsh.bundle.patch`；原型使用 `cordis.patch.yml` | 为真实安装版本声明 `engines.dsh` 与匹配的 peerDependencies |
| 工具注册 | `ctx.tools.register(defineTool(...))` | 当前工具定义有 parameters、output schema/render、execute；不要照抄旧版返回值形式 |
| 事件采集 | `session/event(session, event)` | 是日志追加通知；恢复种子事件不重新发布，启动时必须补读历史；磁盘耐久由 persistence/flush 所属模块保证 |
| 每步准备 | `agent/pre-step(payload, next)` waterfall | 必须保留其他监听器的决定和消息；遵循 AbortSignal |
| 动态上下文 | `ctx.systemPrompt.context(PromptContext)` | provider 同步；本次异步检索应先完成并发布当前 agent 的快照 |
| 系统提示 | `ctx.systemPrompt.section(...)` | 适合稳定规则；动态记忆不应不断修改固定 system prompt |
| UI 包 | `dsh.client.platform: web` 与 `exports["./client"]` | Host 与 Client 是不同运行面，不可把 Node 模块打进前端 |
| UI 组成 | React、`ctx.slots.inject`、`ctx.slots.register` | slot 必须由 owner 声明后再注册，遵循 owner 生命周期 |
| 右侧面板 | `ctx.sidebarRightTabs.register(...)` + `sidebar.right.pane.tab` | 注册类型与 body 共用 definition.id；使用宿主 Session 绑定 |

主要依据：[首个插件教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)、[生命周期教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/)、[工具模块](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)、[会话源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts)、[事件时序](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)、[Client 模块](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)、[Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)、[右侧面板扩展位](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md#extension-seats)。

### 动态上下文的签名和身份

核实的接口为：

```ts
interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}
// ctx.systemPrompt.context(context: PromptContext): () => void
```

`AssembleContext` 有可选 `scope`、`signal`，Agent 模块扩展了可选 `agent`、`modelSelection`。`Agent.id` 的类型就是 `SessionId`；`agent.session.id` 同样来自会话 header。诊断性 assembly 可以没有 agent，此时应返回空的会话记忆，不能回退成全局记忆。

来源：[PromptContext 与 context 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/src/index.ts)、[AssembleContext 扩展与 pre-step 签名](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)、[Agent.id](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/types.ts)。

建议按以下时序实现，属于本插件设计而非官方现成记忆功能：

1. 从可信 Host agent/session 身份解析工作区、Task、当前读取策略版本。
2. 在每步准备阶段完成有预算的异步检索、来源核验和证据快照。
3. 同步 context provider 按 `agent.id` 返回已准备好的文字；原文文本使用 `interpolate: false`。
4. 保持 `await next()` 返回的 pre-step 决定，避免吞掉其他插件的 reject、消息或 request-series 信息。
5. admission 前重核策略版本，防止检索过程中权限变化导致旧快照被使用。

官方时序是先 assembly，再 pre-step，在请求准入前 `refreshContext` 重读注册的动态 context。动态 context 作为耐久的 user-role snapshot 出现在保留历史之后，只有变化或被压缩移除后才重新记录。`required: true` 可以保留必要的运行约束；不应让全部低价值记忆绕过用户关闭可选上下文的设置。`agent/request` 在本次源码中已 deprecated，并明确不能改 messages，不应作为新增记忆注入点。来源：[System Prompt README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)、[运行类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)。

### 原生面板能取得 Session 身份

session-scoped slot 的 `PropsRuntime` 包含 `sessionId`、`useSession`、`useProjection`、`useAccess`；session-maybe 对应可缺省值。Slots 的 inject factory 在 apply 闭包中使用模块，并向 React 组件提供数据与回调，组件本身不接收 ctx。右侧 tab 还通过 `useTabInfo()` 获得 pane、tab 等信息。因此面板可以展示当前窗口的任务归属，又允许切换查看授权范围内其他工作区。

来源：[Slots 组件输入](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)、[sidebar body 注册](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md#extension-seats)。

## 宿主工作区与任务应怎样复用

### 工作区

`ctx.workspaceRegistry` 是现有持久化注册表，提供 `create/get/list/delete/resolveByPath` 等操作。Workspace 有稳定 `WorkspaceId`、规范化 path 和有序 `sessionIds`；真实所有权来自注册记录，不是每次由 cwd 猜测。`attachSession` 校验 SessionHeader.cwd 与工作区路径。`ctx.workingDirectory` 管理后续可变化的执行目录，与初始项目身份不同。

来源：[Workspace 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.md)、[WorkspaceRegistry 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/src/index.ts)、[工作目录参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/working-directory.md)。

建议复用 Host WorkspaceId 并增加 instance/profile 命名空间。插件 Task 的 `workspace_id` 归属变化是业务操作，不应暗中修改旧 SessionHeader.cwd 或假定旧会话已被宿主移动。若执行目录也需迁移，应创建或选择目标工作区的执行 Session，并做显式 handoff。

### Goal

`ctx.goals` 支持每个 Session 一个长期目标，`goal/change` 保存状态，mutation 使用 `{id, revision}` 比较更新。active/paused/blocked/complete 是耐久 phase，armed/disarmed 是进程内状态；恢复和 fork 不自动重获继续运行授权。它不是跨窗口的多任务数据库。

来源：[Goal 模块](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal/README.md)、[Goal 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal/src/index.ts)。

建议 Task/Ticket 是插件的跨会话权威，宿主 Goal 只是当前执行 Session 的目标视图/受控同步对象。给同步带 origin 与 revision，明确写入方向，避免两个状态机互相回写。重启恢复状态和恢复自动执行权限必须分开。

## 持久化和多窗口一致性

官方 Storage 提供 backend + domain；SQLite 是已提供的 backend。domain 写入在耐久提交后才发布 `domain/changed`，但当前明确没有跨表事务、二级索引或跨进程变更推送。因此同 Host 的多窗口与多个独立 DSH Host/profile 是两种部署，不可混同。

来源：[Storage 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md)、[storage-domain 限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/storage/storage-domain/README.md#known-limitations-and-deferred-work)。

针对本插件的建议：

- 首版使用独立单写者记忆/任务模块，内部 SQLite 事务把原文、记忆候选、任务事件、outbox 和处理游标一起提交；向量与图索引作为可重建派生物。
- Host 会话日志仍由宿主权威管理。用 `(instance_id, session_id, event_seq)` 幂等采集，并在启动补读缺口；不要承诺与插件数据库跨库原子提交。
- 一个 Host 的多个 GUI 窗口共享这一模块。多个 Host 若需共享，应连接同一个 daemon，采用 revision/CAS 和可回放更新流；不能让多个进程各自缓存同一 SQLite 文件后认为已经同步。
- 广播只通知对象版本和待读取引用；接受者在每次读取、检索、注入时重新检查范围和 policy revision。推送不是授权。

## 广播撤权与旧上下文

这是根据官方动态 context 的耐久语义推导出的设计要求：把记忆从“整个工作区可见”改成“仅本任务可见”后，停止新检索和清理缓存并不足够。旧证据可能已经写入其他会话的 user-role context snapshot、摘要或回答。插件需要记录 injection receipt（目标 Session、记录序号、证据 ID/revision、策略版本），检查后续请求的模型可见 surface，并使用目标宿主支持的重建/替换路径清除派生上下文；不能安全完成时使用干净 Session 接力，不能继续使用未经清理的历史。

不能撤回已经发给模型的请求、已经生成的输出或用户复制的内容。不要在面板把“阻止今后访问”表达成“从所有历史彻底抹除”。具体 surface 处理必须在锁定宿主版本后验证，目前尚未实施。

## 建议的交付顺序

1. 锁宿主版本，搭最小 Host/Client bundle；验证 pre-step、context、工具、Session 事件、workspace 身份与面板装卸。
2. 抽离 AstrBot 耦合；先迁移原文、来源链、范围策略和现有检索，建立任务事件簿与跨窗口 handoff。
3. 实现工作区归属与广播策略面板，再加权重解释、排序预览、版本回滚；读权限作为硬过滤，不能当成可调分数。
4. 增加长程约束保留、纠错/失效传播、检查点、Watchdog 进展检测；用真实多窗口任务回放评测有效性。
5. 只有出现多进程或多设备需求后，再升级共享 daemon/远程部署；不要求首版复刻完整云端 Super-agent。

应报告恢复正确率、错误任务完成率、过期事实使用率、跨范围泄漏数、证据支持率、任务约束保持率、调用与 token 成本，不能只测“召回条数”或拿文章的调度实验当作本插件准确率证据。
