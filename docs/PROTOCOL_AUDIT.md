# app-server 协议核对记录

核对日期：2026-09-16。初始采样版本为本机 `codex-cli 0.153.2`；后续增加 0.148.0 与 0.153.2 的实际实验协议及隔离启动矩阵，见 [CLI 兼容验收](CLI_COMPATIBILITY.md)。

## 依据与复现

[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)说明，由 CLI 生成的 TypeScript / JSON Schema 与生成它的 CLI 版本对应。前几节记录最初对 0.153.2 文件的检查；随后完成的 0.148.0/0.153.2 隔离启动矩阵见 [CLI 兼容验收](CLI_COMPATIBILITY.md)，真实任务升级与跨端交接仍需单独验收。

```bash
codex --version
protocol_audit_dir=$(mktemp -d)
codex app-server generate-ts --out "$protocol_audit_dir/types"
codex app-server generate-json-schema --experimental --out "$protocol_audit_dir/schema"
```

本次检查的关键产物 SHA-256：

| 产物（相对生成目录） | SHA-256 |
| --- | --- |
| `types/ServerNotificationEnvelope.ts` | `a1f81c486c336d58d3b321d0e49e0196d813dd2372662c09443794170c38142e` |
| `types/v2/ThreadItem.ts` | `ee25d621ee645f49a88e494effcdf625d88cc229edbb184827d8cf4c135ff6f4` |
| `schema/v2/ServerRequestResolvedNotification.json` | `4f03d586a5af04edd912cad08cc97eceb658e7e06744565e6d41a93e04a55966` |
| `types/ExecCommandApprovalParams.ts` | `e1a49f8366b8a70759ee67c917f519bbd25445ee8b6cb7874c8a428b6880afe3` |
| `types/ApplyPatchApprovalParams.ts` | `f2b6d28c35a978746992309781d8d137bc974714aafe841b31124af30f378ab6` |
| `types/FileChange.ts` | `831feada4d69f7049a174ff7abdd49797b4a2a28ba2a2167f44f1aa17b6f3520` |
| `types/v2/PatchChangeKind.ts` | `20e95907d698efbef2fa9d9ab00392b10caf127dfc5e0df1ba9878ad6f42531d` |
| `types/v2/FileChangeRequestApprovalParams.ts` | `32ec2fef83e1e17db98ea0b9b86baaa5c8bf2e8979988f5ad8fef3a93ab15074` |
| `types/v2/ItemStartedNotification.ts` | `99f52740d4e34f5c2b9850953ef8b41aaf3283ff3a733021d04a2dcec3681cce` |
| `types/v2/ItemCompletedNotification.ts` | `f995b1554728867f7464f6f26154e0a0a947f0e6b7b247bdcd24214484cfa836` |
| `types/v2/FileChangePatchUpdatedNotification.ts` | `c7a287dd5f82dbe8ae6018240d3b284999c5c9e578dc5c6d0772cf6e75103de1` |

生成过程不连接共享 daemon，不启动模型任务，不读取任务正文。本记录只保留协议结论和文件摘要。

## 本轮已验证的行为

| 协议证据 | PWA 行为与验证 |
| --- | --- |
| `ServerNotificationEnvelope.emittedAtMs?: number`；注释说明这是通知广播到各连接前的发出时间，毫秒单位，旧版可缺失 | 消息生命周期和回复增量优先采用事件发出时间，随后才回退到 PWA 接收时间。仍标注“约”和“事件发出时间（近似消息时间）”；消息自身的发送/开始/完成字段优先级更高。缺失、非法字段保留旧版回退行为。 |
| `serverRequest/resolved` 的参数为 `threadId: string`、`requestId: string \| integer`；官方文档说明回答完成及请求被清理时都可发出此事件 | 后端收到通知即移除匹配任务的待处理请求，重连状态不会重新带回该请求；排队中的旧审批/回答在实际发送前再次检查。前端在任务过滤之前处理解决通知，背景任务也会清理；同时使正在返回的旧状态快照失效。 |

回归入口：`test/message-time.test.mjs`（时间优先级、延迟、重放、旧版回退）、`test/server-static.test.mjs`（真实 HTTP/SSE 保留发出时间）、`test/thread-write-recovery.test.mjs`（模拟 daemon 的外部解决事件与排队竞争）、`test/mobile-browser.test.mjs`（移动 Chrome 时间显示、当前/背景任务审批清理）。这些测试使用隔离进程或合成事件，不属于真实 Windows/CLI 客户端联调。

## PWA 审批请求身份

PWA 自己生成 `requestToken`，它不是 Codex 上游字段，也不用于识别外部设备。每次收到交互请求都生成新标识，并通过页面事件和 `/api/status` 提供；审批/回答提交携带所查看请求的标识。后端在 HTTP 校验时核对标识，排队结束、写入 daemon 前再核对同一请求对象，防止复用 RPC 编号后把旧决定发送给新请求。

新版后端对缺失或过期标识返回 HTTP 409 `APPROVAL_REQUEST_CHANGED`，明确 `dispatched:false`，不会自动重试原决定；页面重新读取待处理请求供用户确认。升级后仍使用旧缓存代码的页面需要刷新。新页面连接旧后端时仍可使用原接口，但只有部署新版后端后才具备服务器端标识校验。

前端确认、提交共用同一个请求对象的忙碌状态，阻止重复提交；不变的快照和带相同标识的事件回放保留该对象，复用编号的新请求重新显示。旧成功响应只移除它所提交的请求。数值型请求编号 `0` 与字符串形式统一处理。服务器 Web Push 的去重与待处理检查也携带请求身份，内部标识不放入通知正文。

隔离 HTTP/WebSocket 回归覆盖旧操作排队期间编号复用、缺失/过期标识、正确审批与回答；移动 Chrome 覆盖旧确认框、双击/重复提交、回放期间的禁用状态、新请求不被旧响应删除，以及回答失败后保留输入。这些测试不等同于实际 daemon 重启与跨端审批验收。

当前 v106 完整 `npm run release:verify` 为 226/226，通过 97 个模块、145 处本地导入、132 个清单文件与隐私扫描，`git diff --check` 通过。生产后端未重载。

## 旧式审批的任务归属与文件风险

继续核对 0.153.2 生成的协议后，复现旧式 `execCommandApproval` / `applyPatchApproval` 的 `conversationId` 没有进入任务授权和写入队列：授权根目录外的模拟请求也会得到 HTTP 200。协议适配层现在为这两个已知方法将 `conversationId` 映射到 PWA 统一的 `threadId`，保留原字段、RPC 编号和 `callId`。不从 `callId` 推断轮次；若额外携带不同的 `threadId`，以协议声明的 `conversationId` 为准。未知方法不进行这种映射。

所有已支持的交互请求必须提供其协议声明的有效任务标识。缺失、空白或非字符串标识直接回复 JSON-RPC `-32602`，不进入待审批列表；旧式请求不能用额外的 `threadId` 绕过必需的 `conversationId`。有效请求继续使用同一任务的目录授权、排队、请求身份核对、解决通知和界面过滤。

| 0.153.2 协议中的格式 | 本次覆盖 |
| --- | --- |
| `ApplyPatchApprovalParams.fileChanges` 是以路径为键的字典，值为 `FileChange` 的 add/delete/update 联合类型 | 文件影响从字典键提取，delete 保留高风险提示，update 的 `move_path` 同时显示目标路径；有 reason 时仍展示文件变更，避免确认框只剩说明文字 |
| `FileUpdateChange.kind` 是 `{type:"add"}` / `{type:"delete"}` / `{type:"update", move_path}` | 显式提供的结构化变更可识别嵌套删除类型和移动路径；风险检查包含显示上限 8 个路径以外的变更 |
| `grantRoot` 为请求的写入范围 | 在审批摘要和确认内容中显示；仅作请求信息，不修改 PWA 授权根目录，也不宣称上游一定应用该不稳定字段 |

`test/approval-protocol.test.mjs` 覆盖声明字段、原数据不变及文件风险；隔离 HTTP/WebSocket 回归覆盖根目录外请求返回 403、旧式审批在任务写入后排队、协议声明标识缺失时拒绝，以及旧决定的实际响应格式。移动 Chrome 核对文件删除风险、移动路径、写入范围和带文件信息的二次确认，取消时不提交。前端缓存版本为 v107，后端任务归属修复需后续部署后生效。

本轮完整 `npm run release:verify` 232/232 通过，100 个模块、151 处本地导入、135 个清单文件与隐私扫描通过；暂存包实际启动验收继续通过 58 个 public 文件、63 个缓存 URL 以及登录/CSRF/根目录/审批身份检查。生产服务与共享 daemon 未重启。

这些是当前 CLI 中仍声明的旧式协议格式，不能据此宣称已经运行过旧 CLI 版本。当前 v2 `FileChangeRequestApprovalParams` 本身只有任务/轮次/条目标识、时间、reason 和 grantRoot，没有文件变更列表；后续关联实现和证据见下节。

## 新版文件审批与条目关联

依据同一版本的 `ItemStartedNotification`、`ItemCompletedNotification`、`FileChangePatchUpdatedNotification` 和 `ThreadItem.fileChange`，桥接层关联 `item/started`、`item/completed` 及 `item/fileChange/patchUpdated` 中的文件变更。关联键必须同时匹配 `threadId`、`turnId` 和 `itemId`，不从当前打开的任务或最近一次文件变更推断。

PWA 通过独立的 `fileChangeContext` 传递文件影响摘要，不往上游审批参数里伪造 `changes`。摘要含路径、add/delete/update 类型、移动目标、总数、缺失/截断说明与内容指纹；原 Diff 正文只参与 SHA-256 计算，不保存在上下文缓存或审批摘要中。最多缓存 64 个条目、每条显示 32 项变更、每个路径最多 1,024 个字符并标明截短，缓存有效期 5 分钟；删除风险检查全部变更，不受显示数量限制。任务关闭、轮次结束和桥接退出清理对应缓存。

审批卡的摘要及二次确认显示关联文件与删除风险。没有匹配记录、记录不完整或超出显示上限时明确提示，不能据此显示“无风险”或“没有文件变更”。断线后只收到重放审批而没有对应条目时保持“尚未取得文件明细”，不沿用断线前缓存。当前实现不自动订阅任务、接管写入，也不查询完整历史来猜测未收到的条目。

删除发生在显示上限之外时，二次确认开头仍明确提示“包含删除操作”，不因明细折叠而丢掉风险信息。移动 Chrome 还复现旧原生弹窗 `close` 事件延迟到达后关闭新确认框的问题；确认框现忽略已重新打开时的旧关闭事件，回归明确注入这一顺序。

晚到的文件条目或新的 patch 会重新生成 PWA 请求标识并替换待处理请求；即使路径和类型相同，只要 Diff 正文改变，旧确认及排队决定都会失效。相同内容的重复事件保留标识。新上下文同时进入 SSE 和状态快照；浏览器比较上下文并重新呈现风险，打开旧确认框时仍须查看更新后的请求再确认。

回归使用协议实际的“条目通知 + 不含变更列表的审批请求”形状，覆盖跨任务/轮次/条目隔离、延迟条目、patchUpdated、仅 Diff 改变时的排队竞争、断线重放、摘要上限与未知字段。移动 Chrome 核对缺失提示、晚到文件明细使旧确认失效、删除/移动展示和二次确认内容。前端 Service Worker 为 v108；生产后端尚待统一部署，本项不替代真实跨端/长任务/daemon 重启验收。

本轮最终 `npm run release:verify` 239/239 通过，102 个模块、155 处本地导入、137 个清单文件与隐私扫描通过；暂存包实际运行验收通过。确认框竞态先以实际浏览器复现，再以明确的旧 close 事件顺序回归；未通过时没有将该工作包标记完成。生产服务与共享 daemon 保持原进程，未正式发布。

## 保留的证据边界

- 两版生成的通知目录只声明规范方法名，15 个既有替代拼写均未出现；现将其明确标为宽容拼写兼容，不声称来自真实旧 CLI。没有 schema、实际捕获或版本记录时，不扩展别名表。
- `ThreadItem` 的 `userMessage` 有可空的 `clientId`。后续真实 0.148.0/0.153.2 内存任务探针确认：它原样回传调用方的 `clientUserMessageId`，是消息关联字段，不能识别 Windows、CLI、手机或具体设备；`agentMessage` 也没有对等的逐消息设备字段。页面已使用它避免同文消息误合并，来源映射尚未完成，详见 `docs/CLI_COMPATIBILITY.md`。
- 本轮检查的 `Thread`、`ThreadResumeParams`、`TurnStartParams`、`TurnSteerParams`、`TurnInterruptParams` 和 `ClientRequest` 未提供可确认当前外部写入者并安全接管的完整契约。仍以实际冲突为依据，不用创建来源或 PWA 订阅状态推断占用者。
- 新版事件发出时间不会补造旧历史缺失的消息时间；仅能用于携带该字段的事件及其回放。刷新后若只加载缺乏逐消息时间的历史，仍按既有轮次时间回退并标注。
- 已核对基线 0.148.0 与 0.153.2 的实验审批字段，并完成实际 PWA 启动及同一临时状态库连续运行。真实任务中的 CLI/daemon 升级、跨端长时间断线及正式安装/更新/回滚仍需分别验收，不能由只读启动矩阵代替。

## 真实多连接与跨进程写入实验

2026-09-16 在锁定的独立临时 Linux 账号中，以原生 CLI 0.153.2 启动两个 app-server 进程，使用同一份该账号测试状态库。A、B 是第一个进程的两个独立初始化连接，C 连接第二个进程；均为 loopback WebSocket。测试任务实际落盘，模型端点是本机固定等待服务，两次实际 `POST /v1/responses` 均留在本机，不调用外部模型，不接入生产 daemon，也不复制现有认证。

| 操作 | 观察结果 |
| --- | --- |
| A 启动轮次后，B 读取和恢复同一任务 | 读取/恢复成功，`canAcceptDirectInput: true`，没有当前设备身份字段 |
| B 在 A 的轮次运行期间调用 `turn/start` | 请求成功，返回与 A 相同的轮次 ID；不能据此宣称建立了第二轮或存在按连接划分的独占锁。测试随后中止该轮次，未验证这条追加输入实际产生模型回复 |
| C 在第二个进程读取任务 | 读取成功但运行状态为 `notLoaded`、直接输入能力为 `null`；这不代表原进程中的任务没有运行 |
| C 尝试恢复 A 的任务 | JSON-RPC `-32600`，错误为 `thread <id> already has an active writer`；本次没有结构化写入者身份数据 |
| 原轮次中止后，A、B 分别退订 | 两次均返回 `unsubscribed`；第一进程读取仍为 idle，C 恢复仍失败 |
| 再等 10 秒，并关闭 A、B 的连接 | C 仍收到 active writer 错误；退订和断开连接不能在本次条件下证明进程占用已释放 |
| 只结束第一个临时原生进程 | C 随后恢复成功、启动新轮次并触达本机等待端点；测试中止新轮次后清理所有临时进程和账号 |

两个进程返回的创建来源均为 `vscode`，与测试连接自报的名称不同，`extra` 为 null。A、C 的用户消息事件只有 `type`、`id`、`content`、`clientId`，后者分别回传输入的消息关联标识。它们没有提供 Windows、手机或物理设备归属。

本次实际验证 8 组关键断言，生产 PWA/proxy、共享 daemon 的 PID/启动时间和生产配置摘要保持不变。先前的内存任务探针无法恢复落盘历史，故不用于上述写入交接结论。自定义 Unix socket 的初步探测没有通过，最终结论明确限定为该版本的 loopback WebSocket 实验；不冒充 Windows/手机联调。

因此，PWA 的 `owned/released` 仅表达本桥接的订阅状态，`thread/unsubscribe` 成功不是跨进程写入权移交的保证。界面和 README 已去掉“其他设备正在写入，等它完成即可”这一过度推断；现有代码继续保留共享 daemon，不为接管而结束它。R02、R03 仍需外部身份与安全接管的完整契约，R05 仍需真实设备验收。

## 模块边界审计（R08，2026-09-16）

入口文件保留配置、依赖组装和页面级协调，各模块按职责接收所需对象与回调。不会在导入任务模块时启动服务器、CLI 或共享 daemon；状态缓存与队列按应用实例创建。

| 职责 | 代码入口 | 边界 |
| --- | --- | --- |
| HTTP 与认证 | `server.mjs`、`auth-api.mjs` | 先认证和 CSRF 检查，再分发任务、文件、诊断及事件接口；客户端断开只取消未开始的排队写入 |
| 任务 HTTP | `task-api.mjs` | 列表、创建、历史、Goal、写入、归档及审批路由；复用现有设备身份、队列和请求标识 |
| 任务数据 | `thread-service.mjs`、`thread-history.mjs`、`thread-settings.mjs` | 授权任务读取、分页压缩、来源元数据、设置及 Goal 参数；输出/来源/冲突缓存均有上限 |
| 订阅生命周期 | `thread-runtime.mjs`、`thread-mutation-queue.mjs`、`task-recovery.mjs` | 活动轮次、订阅释放计时器、独立写入队列和只读恢复；释放共享订阅不重启 daemon |
| 生成图片 | `thread-artifacts.mjs`、`artifact-store.mjs` | 有界实时图片缓存、rollout 索引及原图响应；缓存命中也重新校验当前任务授权 |
| 协议与传输 | `protocol-adapter.mjs`、`app-server-bridge.mjs` | 适配层集中初始化形状、事件拼写、交互请求方法/身份/决定、订阅参数降级和冲突字段；bridge 负责传输及实时状态转移 |
| 事件流 | `sse-events.mjs`、`event-replay.mjs` | HTTP SSE 打开、重放缺口、心跳、背压及设备断开；广播继续经过恢复观察与推送分发 |
| 诊断 | `diagnostics-api.mjs`、`public/diagnostics-view.js` | 每次读取当前协议、目录策略、队列、恢复和审批快照；页面分别呈现创建来源、订阅证据及写入冲突 |
| 页面任务操作 | `public/task-composer.js`、`thread-actions.js`、`goal-actions.js`、`approval-actions.js` | 新建、发送、追加、中止、组织任务及审批；保留确认、未知结果核对、草稿和任务切换保护 |
| 页面通知 | `public/notification-handler.js`、`event-connection.js` | 前者处理通知对任务和视图的影响，后者管理连接、恢复与回放；诊断不保存通知正文 |
| 其他页面领域 | `thread-list-view.js`、`message-view.js`、`activity-view.js`、`file-browser.js`、`directory-browser.js`、`history-nodes.js`、`history-context.js`、`task-settings.js`、`device-manager.js` | 既有列表、对话、文件、历史、设置和设备模块继续通过显式依赖协作 |

`public/app.js` 仍负责页面共享状态、历史窗口/路由协调和事件绑定；这属于当前应用的组装层，不要求为了行数继续拆成仅转发调用的文件。后端入口从本轮前的约 1,740 行缩至 461 行，前端从约 4,600 行缩至 3,978 行；完成依据是职责和行为验证，不是行数。

审计中先复现并修复两处授权时机问题：缓存中的图片在移除任务目录授权后仍可能读取；恢复归档任务先写入后检查授权。现在图片 GET/HEAD 在任何响应头或字节前核对授权，恢复归档先读取并检查任务，返回的数据再检查规范化目录。另修复来源元数据使用回调式 `fs.open` 当作 Promise 的错误，使用真实临时 JSONL 和符号链接回归核对。

`test/module-boundaries.test.mjs` 的 6 项行为回归覆盖实例隔离、共享 daemon 释放、真实来源文件、上述授权边界、动态诊断快照和降级重试范围。原 HTTP/SSE、审批竞争、重启恢复及移动 Chrome 测试保留；静态接线断言改为读取对应模块，而不是要求代码留在入口文件。

最终 `npm run release:verify` 以退出码 0 完成，252/252 测试通过；暂存包检查 114 个模块、191 处本地导入、152 个清单文件和隐私扫描，实际运行核对 62 个前端文件、67 个预缓存 URL，以及登录、CSRF、授权目录和审批身份。Service Worker 为 v110，应用版本仍为 0.18.15。R08 完成，生产后端尚待统一部署；实机、真实任务和正式发布范围继续由其余工作包验收。
