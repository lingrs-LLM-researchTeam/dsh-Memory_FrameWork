# Memory Framework for DeepSeek Harness

本版本提供 DSH 原生插件、独立 Python 记忆核心与可视化 Dashboard。任务和记忆保存于本地 SQLite；多个对话窗口可以关联同一任务。AstrBot 群聊与学习功能已迁入同级 AstrBot_Memory_Framework；两端保留同版本的纯算法副本。DSH 不依赖 AstrBot。

兼容基线：DSH `0.2.2-rc.1`、Node `>=24.9.0`、Python `>=3.12`。这是单个本地所有者的多窗口方案；独立用户或远程多租户部署需要额外身份隔离。未配置 embedding 时可使用中文全文检索。

## 安装发行包

1. 安装 DSH 插件（若使用 Desktop，请将 `web` 替换为实际 profile）：

```powershell
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add "file:./dsh-memory-framework-0.3.2.tgz"
```

2. 直接启动或重载对应 DSH。插件内置了 Python 记忆核心 wheel 包，默认在 DSH 启动时自动于 `~/.memory-framework/runtime` 创建独立 Python 环境、生成 `credentials.json` 并在后台启动本地核心服务（默认监听 `http://127.0.0.1:18765`），无需在插件目录下手动运行启动脚本。
3. 在 DSH 右侧面板的打开入口中选择「Memory Framework · 记忆与任务」。DSH 原生面板使用宿主 owner 身份，不需要向浏览器提供核心令牌；若需单独在浏览器打开 `http://127.0.0.1:18765` 或脱离 DSH 独立运行，仍可使用 `.memory-framework/credentials.json` 中的 `admin_token` 登录或运行 `./start.ps1`。

宿主插件配置为 `coreUrl`、`instanceId`、`credentialsFile`、`autoStartCore`、`pythonCommand`、`projectGoals`。默认地址与自动启动配置开箱即用。多个 DSH profile 共享同一核心时，为每个 profile 设置不同且稳定的 `instanceId`；多个窗口使用同一个 profile 则保持相同值。`credentialsFile` 是宿主本地路径，不是浏览器 URL。

`projectGoals` 默认关闭。开启且宿主加载 Goal 模块时，会把任务目标单向映射到原生会话 Goal；新建投影立即 disarm，不授予自主续跑权限，已有独立或人工编辑的 Goal 不被覆盖。

## 使用

- 任务与工作区：创建目标、硬约束和验收条件；在多个会话的「会话绑定任务」中选择同一任务。进度更新采用版本比较，过期写入会提示刷新。
- 记忆库：添加、编辑、归档、恢复、软删除记忆，调整单条重要性，固定记忆，查看原文及修改历史。手动修改内容会建立新的人工来源。
- 广播范围：选择会话、任务、工作区、指定工作区或个人全局。读取权限与订阅独立；关闭订阅不会撤回读取权限。当前界面展示最近 1,000 条管理记录，全部有效记录仍可检索。
- 权重实验室：调整六项归一化排序权重、半衰期、召回数量、字符预算和冗余惩罚。预览不会保存；保存产生新版本；历史配置可载入为草稿后重新保存。
- 来源撤销：派生记忆立即隔离，相关任务验收失效。已经接触该来源的会话在后续准入时被阻止；原生面板可建立干净接续会话。旧回复和已发送给模型的请求不能追溯删除。
- 干净接续：新建空会话并绑定当前任务，不复制旧历史。尚未送达的真人输入保存在运行记录中，需核对后重新发送；附件不自动搬运。

任务迁移会解除旧会话绑定，清除旧工作环境下的验收证据，不自动移动历史记忆或扩大共享范围。请在目标工作区的会话中重新绑定任务。

模型可调用 `memory_framework_search`、`memory_framework_read`、`memory_framework_remember`、`memory_framework_task_state`、`memory_framework_task_update`、`memory_framework_checkpoint`。模型不能管理共享授权、替换用户约束或自行完成用户验收。

## 可选向量模型

核心支持 OpenAI-compatible embedding HTTP 接口。环境变量在启动核心的进程中设置：

```powershell
$env:MEMORY_EMBEDDING_URL = 'https://your-provider.example/v1/embeddings'
$env:MEMORY_EMBEDDING_MODEL = 'your-embedding-model'
$env:MEMORY_EMBEDDING_KEY = '<你的密钥>'
$env:MEMORY_EMBEDDING_REVISION = '1'
$env:MEMORY_EMBEDDING_DIMENSIONS = '1024'
```

URL 必须是完整 embeddings 接口。维度可省略并自动探测；模型语义版本变化时更新 `REVISION`。首次建索引异步进行，词法检索仍可用。向量和元数据保存于 SQLite，FAISS 仅检索已通过范围和来源校验的候选。调用失败会返回降级标记，不伪造向量结果。

后台建索引在每条请求取得向量调用锁后，重新核对记忆版本、状态、语义检索开关、来源及工作区策略；已失效的批次快照跳过且不计入调用预算。核对与网络请求不是一个原子操作：核对后发生的撤销不能撤回已准入的请求，但旧版本结果不会写入向量索引。

## 从源码开发

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[test]"
cd dsh/plugin
npm ci --legacy-peer-deps
npm test
npm run build
cd ../..
.venv/Scripts/python -m memory_framework init --data-dir ./data/dsh
.venv/Scripts/python -m memory_framework serve --data-dir ./data/dsh --ui-dir ./dsh/plugin/dashboard
```

源码运行使用 `./data/dsh` 时，将 DSH 插件的 `credentialsFile` 改为该目录下 `credentials.json` 的绝对路径。独立开发服务器可运行 `npm run dev`，其代理指向本地核心。

构建完整发行包：

```powershell
.venv/Scripts/python tools/build_dsh_release.py
```

输出位于 `dist/dsh`，包含 npm 包、Python wheel、Dashboard、源代码、报告及 SHA-256 清单。构建链先用 TypeScript 转译标准装饰器，再由 tsdown 打包；不要直接把含装饰器语法的源文件当作 Node 产物发布。

## 验证和边界

本次验证包含核心行为、真实 DSH Gateway、原 AstrBot 回归和真实浏览器 Dashboard 操作。没有使用用户的模型密钥或运行收费的长期模型基准，也没有在用户的真实 DSH Desktop 安装中启用插件。因此不能据此声称具体的准确率提升或幻觉降低百分比。

广播是版本引用通知，约 2 秒轮询，下一步重新读取权威状态；不强行唤醒闲置任务。多个独立 Host 的并发撤权在轮询与请求检查间仍有时间窗口，已经进入模型的请求无法撤回。版本比较保护任务状态，不代替代码工作区的文件锁或独立 worktree。

来源每条最多保留 200,000 字符，超长事件记录截断标记、原始长度和 SHA-256；自动记忆摘录最多 12,000 字符。全文日志仍由 DSH 管理。向量检索缓存授权候选的内存 FAISS 索引，候选集合或向量代次变化时重建；超大语料仍需要进一步性能验证；不声称已支持任意规模。

运行环境继承本仓库 MIT 许可与既有上游归属。详细实现和证据见技术报告。


## 0.3.0 上下文联动与预算

Dashboard 新增「预算与收录」。每个工作区独立设置：每轮证据总字节数、自动注入字节数、工具调用次数、写入次数、原文分页字符数、工具输出收录模式、工具白名单、错误结果开关、向量化开关、暂停索引及每日向量输入字符预算。策略保存使用版本检查，过期草稿不能覆盖其他窗口。

默认跟随 DSH 当前窗口所选模型的上下文容量；每次准入重新读取该步骤的 provider/model 路由和输出上限。自动记忆配额按剩余容量的 10% 保守规划（1 Token 容量按 1 UTF-8 字节规划），最高 128,000 字节，另默认保留 20,000 字节给记忆工具。384,000 Token、输出 8,192 Token 时，自动记忆配额为 37,580 字节。未知容量或手动模式才使用原先每轮 32,000／自动 12,000 字节与 context_chars 限制。这不是设置 DSH 的总 Token 窗口。每轮最多 12 次记忆工具调用、3 次写入，原文每页 2,000 字符。计数由 DSH 的可信 turn/start 事件重置，模型不能自行重置；同一事件重放不补充额度。预算不包含 DSH 其他工具、普通历史和模型输出，字节/字符并不等于计费 Token。

工具输出默认只保存为原始证据。可以在面板手动收录，或者允许指定工具自动生成记忆；默认跳过错误、超过 4,000 字符和同会话且同任务内重复的工具输出。原文不因未收录而删除。手动收录默认不向量化，记忆编辑中可以单独启用「参与语义检索」。更改收录规则仅作用于新事件，已有记忆由用户管理。

每工作区每天默认最多尝试向量化 200,000 输入字符，按 UTC 日计数并持久化，查询与文档共用预算；失败尝试也计入。查询缓存 5 分钟/128 条，文档失败按条目退避，不阻塞其他工作区。关闭语义检索仍可使用全文检索。

升级前停止旧核心并备份数据目录。0.3.0 自动将 SQLite schema 1／2 升级至 3，保留原有来源、任务、记忆和共享范围。请成套更新 Python wheel 与 DSH 插件。回退到旧版本须恢复升级前的数据库备份，不能让旧进程写新库。Windows 新建及再次启动核心时都会收紧凭证文件 ACL。


首次运行会在宿主日志及 Dashboard 推荐：模型和服务支持时，将 DSH 上下文窗口设置为 **384k–500k Token**。插件不会修改模型配置或扩大服务商限制；大窗口有助于保留任务要求，但不能保证消除幻觉，可能增加费用和延迟。在 Dashboard 点击「已了解，不再提醒」后，确认状态保存在本地核心，跨窗口和重启有效；建议仍可在预算页查看。

「预算与收录」可选择跟随／手动模式、调整记忆占比（1–20%），查看各会话最近一次宿主报告、实际自动配额与总证据预算。切换到小窗口后会重新约束注入，任务契约和固定记忆过大时明确提示。完整系统提示、历史、工具和输出的组装与压缩仍由 DSH 承担；插件没有遍历或重新分词整段历史。

Dashboard 默认夜墨，可切换纸白，使用系统字体与轻量 CSS；无远程字体、视频、Canvas、WebGL、持续动画或模糊滤镜。面板可见时每 10 秒刷新，隐藏时取消请求并暂停，返回时立即同步；保存后立即刷新。记忆每页 24 条，候选证据分批显示，窄侧栏按自身宽度适配。宿主撤权检查仍保持 2 秒轮询，并在模型准入时复核。


## 0.3.1 有限动效与策略开关

页头新增 15 个圆点的缩放波纹和 Memr0y 字样；圆点只播放两轮（最长约 7 秒），然后静止，可点击重播。滚出视口或页面隐藏时暂停；刷新数据不重播。侧栏「轻动效」可关闭装饰与开关过渡，并保存本地偏好；系统「减少动态效果」优先。

预算页三个工作区开关改为整行可点击的按钮：50 × 30 像素轨道、14 像素标题、11 像素说明，滑块在 240 ms 内移动，×／√ 交替出现，渐变背景在 220 ms 内显现。支持空格／回车和读屏状态；修改后仍需「保存策略」，不会因切换意外提交。暂停开关明确显示「已暂停／未暂停」。390 像素窄屏及原生窄侧栏可自动换行。

不使用 Canvas、WebGL、模糊滤镜、逐帧 React 更新或第三方动画库。性能采样及截图见详细技术报告第 14 节。0.3.1 不改变上下文算法、schema 3 或权限规则。


## 0.3.2 工具同名冲突修复

DSH 全局工具名必须唯一。该项目的旧版插件可能会与 dsh-linghun 在内的部分记忆插件同时注册 memory_read 导致本插件装载失败；本版本六个工具统一使用 memory_framework_ 前缀，理论可避免此问题，但实际仍不建议您与其他记忆辅助插件一同使用，否则仍然可能导致意外的情况
