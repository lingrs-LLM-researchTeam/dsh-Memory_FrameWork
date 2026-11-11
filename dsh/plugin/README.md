# dsh-memory-framework

DeepSeek Harness `0.2.2-rc.1` 原生长期记忆与跨会话任务插件，提供右侧「记忆与任务」面板。

安装插件后，启动 DSH 即可自动在后台初始化并拉起配套 Python 记忆核心（使用 `dsh plugin --profile web add <本包路径>` 安装）。默认核心地址为 `http://127.0.0.1:18765`，凭据文件为 `~/.memory-framework/credentials.json`。

配置项：`coreUrl`、`instanceId`、`credentialsFile`、`autoStartCore`、`pythonCommand`、`projectGoals`。多个 Host/profile 必须配置不同的 `instanceId`；同一 Host 的多个窗口共享实例标识。

提供记忆 CRUD、来源核验与撤销、广播范围、任务绑定和工作区迁移、检查点、验收控制、排序权重预览与版本回滚。浏览器通过 DSH Gateway 的 owner 身份调用，不持有核心管理令牌。

0.3.0 默认跟随当前步骤模型的上下文容量；首次运行建议在模型支持时设置 384k–500k Token。Dashboard 支持自动／手动记忆配额、可调占比、夜墨／纸白杂志风界面、24 条分页及隐藏暂停刷新。成套升级至 Python 核心 0.3.0，升级前备份数据；schema 1／2 自动迁移至 3。

模型工具：`memory_search`、`memory_read`、`memory_remember`、`memory_task_state`、`memory_task_update`、`memory_checkpoint`。

主安装说明随完整发行 ZIP 的 README 提供；源码仓库中位于 `dsh/README.md`。报告位于 `docs/DSH开发技术报告.md`。本包继承 MIT 许可。

0.3.1 新增有限圆点动效及渐变策略开关；支持静态偏好、系统减少动态效果和不可见时暂停。后端协议与 schema 3 保持不变。
