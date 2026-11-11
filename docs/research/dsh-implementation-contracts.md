# DSH 0.2.2 插件实现契约

核验日期：2026-11-11。目标基线为实际 npm 发布的 `0.2.2-rc.1`。本次在 `E:\Github_repo\dsh-memory-audit` 安装官方包并编译 Host、Client、事件采集、上下文和干净会话交接样例，另以真实 Gateway 运行权限与 schema 检查。本文描述已验证接口及实现必须补齐的业务约束，不代表完整插件已完成。

## 版本与可复现资料

| 包 | 核验版本 |
| --- | --- |
| @deepseek-ai/dsh | 0.2.2-rc.1，Node >=24.9.0 |
| @deepseek-ai/dsh-agent、dsh-session、dsh-tools、dsh-system-prompt、dsh-workspace、dsh-goal | 统一 0.2.2-rc.1 |
| dsh-api-gateway、dsh-api-remote-access、dsh-typert-protocol、dsh-typert-registry | 统一 0.2.2-rc.1 |
| dsh-client-connection、dsh-client-ui-renderer、dsh-client-ui-slots、dsh-client-ui-session、dsh-client-ui-sidebar-right | 统一 0.2.2-rc.1 |
| @deepseek-ai/cordis | 4.1.0 |
| @deepseek-ai/schemastery | 3.19.0 |
| 审计编译器、React、Zod | TypeScript 6.0.3、React 18.3.1、Zod 4.4.3 |

npm dist-tag 不一致：`dsh` 的 latest 是 0.2.2-rc.1，但本次 `dsh-agent` 的 latest 仍为 0.1.0-rc.6，`dsh-tools` 等包的 latest 仍为 0.0.1-rc.1；它们的 next 才是 0.2.2-rc.1。必须显式锁完整版本，不能安装各包裸 latest。来源为 [DSH npm 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)、[agent 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent)、[tools 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh-tools)，以及审计目录中的 package-lock.json 和各包 package.json。

`dsh-memory-audit/fixtures` 下的 `contracts.ts`、`host.ts`、`client.tsx`、`events.ts`、`context.ts`、`handoff.ts`、`inbox-observation.ts`、`handoff-client.ts` 是已编译的接口样例。依赖用 `--ignore-scripts` 安装。验证命令：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json
node build/smoke.js
```

编译采用 strict，skipLibCheck 只跳过依赖声明内部检查。运行烟测通过 owner 调用、错误参数类型拒绝、伪造 principal 字段拒绝、无授权 Peer 拒绝、已销毁 Peer 拒绝。尚未据此验证真实 Desktop/Web UI 的安装、热重载或完整网络登录流程。

## Host 插件与打包

Host 使用 `import type { Context } from '@deepseek-ai/cordis'`，配置 Schema 的运行时导入是 `import Schema from '@deepseek-ai/schemastery'`。导出 `name`、`inject`、`Config`、`apply(ctx, config)`。相关官方包的 `import type {}` 会合并 Context 服务与事件类型，不能只手工声明一个不受 SDK 检查的“大 Context”。

客户端与 Host 分开构建。package.json 保留：

```json
{
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" },
    "manifestVersion": 1
  },
  "engines": { "node": ">=24.9.0", "dsh": "0.2.2-rc.1" }
}
```

这是入口形状；发布文件、Client 依赖 inject 和构建方式必须对应实际 bundle。原型的打包实例见 [package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/package.json)，Host 入口见 [src/index.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/index.ts)。所有资源通过 Cordis effect 或所属 fiber 管理，卸载时关闭 sidecar 连接、事件订阅和轮询。

## Host 和 Client 的认证 RPC

### 接入方式

真实机制是 Typert Gateway，不是虚构的 `ctx.rpc`：

1. Host 的业务类继承 `TypertRemoteService`，公开方法用 `@Remote`。方法最后一参可为 `signal: AbortSignal`。
2. 共享一个严格 `InvocationDescriptor[]`，输入和结果 codec 使用 Zod schema。Host 在 `ctx.typert.register({package, face:'host', schemas:[], model:{services:[],events:[],objects:[]}, invocations})` 注册。
3. Client 执行 `await ctx.remote.$mount({package, descriptors})`，再调用类型合并后的 `ctx.remote.memoryAudit.status(request, signal)`。
4. Client unary 结果是 `{ok:true,value}` 或 `{ok:false,error}`，必须检查 `ok`；不能把结果直接当 payload。
5. Host 从 `this.ctx.invocation?.peer.principal` 取得宿主认证的调用者；该身份不可由 JSON 请求设置。管理面板首版限定 owner。模型工具身份另外从 `execution.agent` 取得。

完整可编译例子在审计目录 `contracts.ts + host.ts + client.tsx`。共享 schema 推导请求/响应 TypeScript 类型，避免契约多处复制。手工严格 descriptor 的公开注册方式与官方 [Gateway Host 测试](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/tests/gateway.host.spec.ts)、[Gateway Client 测试](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/tests/gateway.client.spec.ts) 一致；另一条路径是官方 Typert 构建生成器，但外部插件不必为了简单的几个管理方法复制整个宿主 monorepo 构建。

最小 descriptor 形状：

```ts
{
  id: 'dsh-memory#memory/status',
  service: 'memory',
  namespace: 'memory',
  method: 'status',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-memory#Request', create: () => RequestSchema },
  }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: 'dsh-memory#Reply', create: () => ReplySchema },
}
```

### 身份与权限要求

Connection 承载认证、HTTP/IPC 运输与请求关联，Gateway 承载参数检查和 Remote 调度。非 owner 的 Remote 调用还受 `remoteAccess` 资源策略控制；默认不授予任何新插件管理权。首版可主动拒绝非 owner；以后若开放协作者，必须完整声明被访问的工作区/会话资源，不能只检查“登录过”。

面板将所选 sessionId/workspaceId 作为目标，不把它当调用者身份。sidecar 密钥只存在 Host；React 通过既有 DSH Connection/Gateway 调用 Host，Host 再访问 loopback FastAPI。普通 `ctx.webServer.register` 没有自动认证；不要复制 Super-agent 原型仅针对 loopback 的自定义 HTTP 校验，冒充 DSH Gateway 身份控制。

来源：[Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/README.md)、[Typert 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/typert/protocol/README.md)、[认证访问测试](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/tests/gateway-access.host.spec.ts)、[WebServer 范围](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)。

## React 面板与会话身份

`ctx.slots` 的 Context 声明由 `@deepseek-ai/dsh-client-ui-renderer/client` 提供，不只是 ui-slots 类型包。需要的类型导入：

```ts
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
```

右侧面板类型注册为 `ctx.sidebarRightTabs.register({id,kind,title,guide})`；body 在 owner 生命周期内：

```ts
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: definition.id,
    inject: () => ({ read }),
  }, Body))
```

`PropsRuntime<'sidebar.right.pane.tab'>` 有可信的宿主 UI 绑定 `sessionId`，但后端仍要核对其权限。注册的 `inject` 向组件传受限数据/回调，而不是把 Host token 或 Node 客户端带进 React。RPC 请求随 AbortController 在卸载或 Session 改变时取消。

来源：[面板扩展位](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md#extension-seats)、[Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)。编译例子见 `fixtures/client.tsx`。

## 会话事件与回放

实时订阅签名：

```ts
ctx.on('session/event', (session, event) => {
  // session.id, event.seq, event.time, event.type, event.data
})
```

| event.type | 数据所在位置 |
| --- | --- |
| user/message | `event.data` 就是 UserMessage，含 id/role/content/source |
| assistant/message | `event.data.message`；同级含 turn/step/stream/usage?/interrupted? |
| tool/call | `event.data.callId/name/arguments`；arguments 是原始 JSON 字符串 |
| tool/result | `event.data.message.toolCallId/content/isError?`，source.kind 为 tool |
| agent/inbox/spliced | 待处理消息的持久变化；不是已经进入模型的用户消息 |
| request/context 等 | 请求构造信息；不要当用户原始证据 |

所有消息 content 是 ContentBlock 数组，不是简单字符串。user-role 不等于真人输入：`source.kind` 区分 user 与其他上下文生产者；全局概括不能把注入记忆再当独立证据，模型输出也不能直接提升成已证实事实。事件定义见 [session types](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)，消息定义见 [llm message](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/message.ts)。

历史读取用持久化只读 handle：

```ts
const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal })
try {
  const { events, eventState } = await handle.read(offset, 100, { signal })
  // 不修改共享冻结的 events；按 seq 幂等采集。
} finally {
  await handle.close()
}
```

`Session.snapshotEvents/eventAt/ownEvents` 已 deprecated，官方禁止新增调用。恢复种子历史不会重发 `session/event`，所以启动时必须从游标补读。先订阅实时流再补读，以事件身份幂等合并，避免初始化缺口。已追加事件只是内存提交；`ctx.sessions.flush(session)`/持久化 flush 是耐久屏障。插件不得抢 `open(...,'write')`，也不能把自己的 DB 提交描述为与宿主跨库原子事务。

来源：[Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts)、[Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/src/index.ts)。npm 真正类型位于审计目录 `node_modules/@deepseek-ai/dsh-session-persistence/lib/types/{index,handle}.d.ts`。

## pre-step、上下文与撤权

真实 payload 为 `{agent,messages,turn,step,signal,modelSelection}`；`next()` 返回：

```ts
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

上下文 provider `text: ({agent}) => string` 是同步的。每步异步检索先在 pre-step 完成，再通过 Map 保存该 Agent 的授权快照；保留 downstream 的完整 decision。宿主先 assemble，后 pre-step，再于 admission refresh 重读已注册 context。`AssembleContext.agent` 可缺省，诊断调用应返回空串。

旧 context 是耐久 user-role snapshot。新 provider 返回空并不删除旧模型历史，更不删除其摘要或已生成文本。首版推荐保守但清楚的处理：

1. 授权变窄时，持久保存受到影响的 Session fence 与 policy revision。
2. 所有后续 pre-step 拒绝受污染 Session；同步 context provider 的 admission 检查再次核对 fence/revision。
3. 面板提供“创建干净会话继续任务”；只带重新授权的任务约束、状态、证据，不复制原会话历史，也不 fork。
4. 新 Session 建立 Task 绑定、核验新策略后，继续原任务；旧 Session 的污染 fence 保留。
5. 记录哪些输入未完成准入并提供交接，不让拒绝步骤吞掉用户输入。

第 5 点来自官方时序的重要限制：rejected/failed pre-step 已 claim 的 batch 不自动回到 inbox。需要按 MessageId 保存 `agent/inbox/claimed` 的待准入记录，并以稍后的 `user/message` 确认消费；初次 assembly 也可能在 pre-step 之前抛错。`fixtures/context.ts` 只验证接口形状和同步 fence，不是完整输入恢复实现。

精确的 claim 监听器为 `ctx.on('agent/inbox/claimed', ({agent, message, turn}) => ...)`。`message.id` 与随后 `user/message` 事件的 `event.data.id` 是同一个 MessageId；按 `(sourceSessionId, MessageId)` 关联，不能按文本或 turn 去重。`fixtures/inbox-observation.ts` 将两类操作放在同一写入链，并暴露 `flush()` 给 pre-step/handoff 等待。emit 监听器的 Promise 不会成为宿主耐久屏障；进程崩溃后仍需用原始 inbox 持久事件补回未确认记录。

跨 Host 的撤权若要声称即时生效，必须协调所有活跃 Host 的 fence 确认，并让失联 Host 停止准入；异步订阅落后只能提供最终一致。已经发出的 LLM 请求、旧输出和用户副本无法撤回。`agent/request` 已 deprecated，且不允许修改 messages，不能用它偷偷覆盖请求历史。

来源：[事件时序](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)、[运行事件签名](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)、[System Prompt](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)。

## 工具执行身份

工具写法见 `fixtures/events.ts`：

```ts
ctx.tools.register(defineTool({
  name: 'memory_audit_identity',
  description: 'Return this tool caller session identity.',
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(_args, execution) {
    execution.signal.throwIfAborted()
    if (!execution.agent) throw new Error('A model session is required')
    return execution.agent.id
  },
}))
```

`execution` 是 ToolRunContext，提供 agent?、signal、callId、rootCallId 等。没有 agent 的程序调用必须被记忆插件拒绝或单独明确授权。scope/session/workspace 必须由 Host 身份解析，不让模型参数选择自己的权限。来源：[工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/contracts.ts)、[工具模块](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)。

## Workspace、Goal 与干净会话

已编译的工作区查询：`ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(agent.id))`。不存在归属时为 unassigned，不回退全局。服务还提供 `create(path,title?)`、`get(WorkspaceId)`、`resolveByPath(path)`；实体的 `attachSession(SessionId)` 会检查 immutable header.cwd。不要用可变当前目录冒充工作区身份。

Goal 实际签名：

```ts
ctx.goals.get(agent): GoalView | undefined
ctx.goals.create(agent, { objective, maxGoalRounds? }): GoalView
ctx.goals.edit(agent, { id, revision }, { objective?, maxGoalRounds? }): GoalView
ctx.goals.pause(agent, { id, revision }): GoalView
ctx.goals.resume(agent, { id, revision }): GoalView
ctx.goals.complete(agent, { id, revision }): GoalView
```

Goal 一会话一个、要求真实 live Agent 与 revision，不是跨窗口 Task 表。恢复状态不自动恢复继续运行许可。建议插件 Task 为权威，宿主 Goal 作有方向的投影。

干净会话创建已在 `fixtures/handoff.ts` 编译：

```ts
ctx.sessionController.create({ workspaceId, agentPreset })
// Promise<{sessionId: SessionId, agentPreset?: string}>
```

`workspaceId` 与 `cwd` 互斥。不传旧 sessionId；那是可能复用空会话的选项。此接口创建普通会话，避免 `fork` 继承旧证据。创建后的 Task 绑定、交接内容和自动继续授权由插件显式处理。

已保存的真人输入可在 Host 完成重新授权后经 `const resolved = await ctx.sessionController.resolveAgent(newSessionId)` 取得 live Agent；结果是 `{agent}` 或 `{error}`。随后 `resolved.agent.followup(savedUserMessage)` 保留原 MessageId、source 与 content，排入 next-turn 并唤醒，再 `await ctx.sessions.flush(resolved.agent.session)` 建立耐久屏障。这是已有入口，不存在 `agent.accept`。`agent.send(message, 'next-turn', false)` 可只排队不唤醒，但不能把“排队成功”当成已请求模型。

实际交接顺序为：owner 管理请求 → 源 Session fence/待输入日志落盘 → 创建干净会话 → 新 Task 绑定与当前策略校验 → 记录 delivery intent → 重投经重新授权的真人输入 → 持久化确认 → 返回新 SessionId。不能搬运旧的 memory context；附件也要重新验证目标可访问性。崩溃重试必须检查目标 pending inbox 与已准入 user/message 两处的 MessageId，不能仅凭 sidecar 的 queued 标志再投一次。完整接口片段见 `fixtures/handoff.ts`。

客户端调用插件自己的 owner-only handoff RPC，收到新 SessionId 后 `await sessions.refresh()`，确认 `sessions.list.getSnapshot().phase === 'ready'` 且 `byId[id]` 存在，再调用 `ctx.uiWorkspace.openSession(id)`。浏览器不提交待恢复消息正文或伪造来源；Host 从自己的 journal 读取。类型化片段见 `fixtures/handoff-client.ts`，导航路径也见 [官方原型 navigation.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/navigation.ts)。

来源：[WorkspaceRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/src/index.ts)、[Workspace 类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/src/types.ts)、[Goal](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal/src/index.ts)、[SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/index.ts)、[会话创建类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/types.ts)。

