# Codex PWA

一个面向手机和桌面浏览器的 Codex Remote Web UI，通过本机 `codex app-server` 操作 Linux 服务器。当前版本为 `0.19.1`。

它适合通过蒲公英、ZeroTier、Tailscale 等受控私网使用。Windows 笔记本关机后，只要 Linux 服务器、用户级 systemd 和网络入口仍在运行，手机就可以继续查看或操作 Codex 任务。

`v0.13.0` 还提供断网后的 SSE 自动重连、完整活动历史按需载入、Goal 创建/编辑、服务器文件上传/新建/重命名/移动/复制/删除，以及 Markdown、PDF、图片和常见音视频预览。删除操作只允许空目录，文件操作默认拒绝覆盖。

`v0.14.0` 进一步将服务器文件操作收纳到三个点菜单，优化移动端任务与 Goal 布局，并新增按轮次整理 Prompt 的历史对话节点面板；使用帮助页面打开时不会自动唤起手机输入法。

`v0.15.0` 微调手机端标题、任务和文件菜单的居中与留白，移除文件根目录的单项面包屑，并统一使用帮助文案间距。

`v0.16.0` 进一步将手机端标题锚定到视口中心，统一任务和文件菜单的内侧对齐，并移除文件菜单按钮的选中背景。

`v0.17.0` 是正式分发前的稳定性版本：修复异常请求崩溃、后台恢复和审批状态竞争，加入可续载的窗口化历史渲染，并完善干净 ZIP、原子更新和兼容卸载流程。

`v0.17.1` 修复移动端历史节点长列表回弹与日期越界，支持回复中的服务器图片原位预览和重复产物抑制，并适配 Codex `0.153.2` 的轻量任务恢复方式。

`v0.17.2` 为历史对话节点增加明确的初始加载状态，避免在服务器响应前误显示“没有历史节点”。

`v0.18.0` 修复浮动菜单触摸关闭、归档状态串扰和写请求超时歧义，统一同级操作按钮字号，并为长时间实时输出、安装配置继承及 ZIP 更新健康检查增加稳定性保护。

`v0.18.1` 移除会话页重复的新建按钮，将顶部操作菜单改为竖向三点，并统一会话、目录和文件列表的整行无圆角高亮。

`v0.18.4` 统一短暂操作反馈的位置：普通提示固定在会话标题栏下方，历史节点定位成功提示紧跟历史上下文横幅显示，避免遮挡手机底部输入区；历史上下文横幅同时贴近标题栏下沿。

`v0.18.5` 提升确认操作的颜色对比度，并为历史节点、历史上下文、会话载入、文件浏览、设备管理和 Goal 保存等可能耗时的操作统一增加顶部加载提示与旋转指示；加载提示使用请求令牌避免旧请求关闭新提示。

`v0.18.6` 为历史节点定位增加弹窗内可见的加载条，避免原生模态框遮挡顶部提示，并在定位期间锁定节点操作，完成后自动恢复。

`v0.18.7` 修复新模型未出现在 app-server 模型目录时被错误显示为默认模型的问题，并兼容任务模型设置的嵌套响应结构。

`v0.18.8` 修复 GitHub Actions 中移动端浏览器启动竞态与 Node.js 工具链路径差异，使发布前检查可在 GitHub 托管运行器稳定复现；同时支持通过隔离的干净镜像和仓库专用 Deploy Key 原子推送版本，标签测试通过后自动创建 GitHub Release。

`v0.18.9` 延长 GitHub 托管运行器的 Chrome 启动等待，在 CI 中启用兼容启动参数，并在浏览器提前退出或超时时保留诊断信息。

`v0.18.10` 增加用户名或密码修改入口。修改前需要验证旧凭据，成功后会撤销所有可信设备并要求重新登录；旧部署继续使用默认用户名 `codex`，直到主动修改。

`v0.18.11` 递增 Service Worker 缓存版本，确保已经安装的 PWA 能取得最新资源。

`v0.18.12` 完善公开仓库、AI 辅助安装、多人隔离和私网排障说明。

`v0.18.15` 补充私网端口防火墙配置提示，避免服务器本机健康但手机无法连接；`v0.18.14` 修复 systemd 安装路径格式问题，并在启动服务前自动校验生成的 unit。

`v0.19.1` 增加主要消息的时间与来源说明、断线/服务重启后的任务核对、写请求结果确认、文件审批关联与可选 Web Push，并改善阅读位置、弹窗和无障碍交互。自动回归、原生任务恢复及独立账号安装/升级/回滚已有实际证据；具体设备身份、安全接管、厂商推送与实机验收仍按相关文档列出的范围继续跟踪。

> 这是社区自建客户端，不是 OpenAI 官方发布的 Web UI。`codex app-server` 的部分协议仍可能变化，升级 Codex CLI 后应重新运行测试。

## 最重要的部署原则

每个人必须使用独立的：

- Linux 账号和 home 目录；
- Codex 登录/API 凭据；
- app-server daemon 和 Unix socket；
- PWA 服务、端口和 Web UI 密码；
- `CODEX_PWA_ROOTS` 文件访问范围。

不要让多人登录同一个 PWA 实例。PWA 拥有运行它的 Linux 用户的文件和命令权限，共用实例会导致任务、文件、凭据和 API 账单混在一起。

## 安装

前提：目标 Linux 账号中已经安装 Node.js 22+、npm 和 Codex CLI，并已完成该账号自己的 `codex login`。PWA 直接复用当前账号的 Codex CLI 认证；API Key 登录（例如 `codex login --with-api-key`）和 ChatGPT 登录都由 Codex CLI 自己管理，PWA 不会替换或上传这些凭据。使用 ZIP 还需要 `unzip`，使用 Git 克隆还需要 `git`。

干净 ZIP 分发包可以解压到该 Linux 用户有写权限的任意目录：

```bash
unzip codex-pwa-vX.Y.Z.zip
cd codex-pwa-vX.Y.Z
npm run setup
```

也可以从经过隐私清洗的公开 GitHub 仓库克隆后执行 `npm run setup`：

```bash
git clone https://github.com/pgycz2024/codex-pwa.git
cd codex-pwa
npm run setup
```

公开仓库只包含清洗后的程序、文档和测试，不包含服务器任务、项目文件、登录凭据或个人 GitHub 凭据。需要可复现的固定版本时，将上面的克隆命令替换为 `git clone --branch v0.19.1 --depth 1 https://github.com/pgycz2024/codex-pwa.git`；也可以直接从 GitHub Releases 下载对应版本的 ZIP。

安装程序会自动：

- 安装 Node 依赖；
- 检查该用户自己的 Codex 登录；
- 查询并复用已运行的 Codex daemon；尚未运行时通过 `codex app-server daemon bootstrap/start` 初始化；
- 新安装默认只允许访问 PWA 安装目录，可用 `--root /absolute/project/path` 指定工作目录；
- 从 4177–4277 自动选择空闲端口；
- 检测 `oray_vnc` 蒲公英 IP；
- 让 Node 服务继续只监听 `127.0.0.1`，再用 systemd socket proxy 仅在私网 IP 暴露所选端口；
- 生成独立的 Web UI 密码；
- 支持在登录页或“已登录设备管理”中修改用户名和密码；
- 启动服务并执行 HTTP 健康检查。

安装结束会显示手机网址、登录用户名 `codex` 和首次密码。

如果使用蒲公英或其他私网入口，管理员还必须在服务器防火墙中放行安装输出的那个端口。以 `oray_vnc` 蒲公英接口为例（将地址和端口替换为安装输出的值）：

```bash
sudo ufw allow in on oray_vnc to PRIVATE_IP port PORT proto tcp comment 'Codex PWA via PgyVPN'
```

这条规则只放行指定私网接口、指定地址和指定 TCP 端口；安装器不会擅自取得 `sudo` 权限或修改全局防火墙。若手机页面一直加载，先访问 `http://PRIVATE_IP:PORT/api/health`，再检查 `sudo ufw status`、蒲公英组网和 `codex-pwa-private.socket`。

第一次安装最好在该用户没有正在运行的 Codex 任务时进行。新账号建议先按 [OpenAI 官方 CLI 安装文档](https://learn.chatgpt.com/docs/codex/cli#getting-started)准备 standalone 安装；npm 安装的 CLI 0.153.2 在新账号下可能提示 `managed standalone Codex install not found`。PWA 安装器不会自行下载或替换 Codex；缺少前提时会在修改 PWA 服务配置前停止，并保留上游错误。

安装器会先查询 daemon，复用已确认运行的实例，避免重复 `bootstrap` 替换后台进程、影响任务。也可显式使用 `npm run setup -- --skip-daemon-bootstrap`，要求只连接已有 daemon；这个选项不会创建或启动 daemon。如果 CLI 成功返回但状态结构无法识别，安装器停止并提示核查，不执行 daemon 生命周期命令。

安装器的常用选项：`--root PATH` 限制文件管理器和任务工作目录（新安装默认是 PWA 安装目录，多个根目录用冒号分隔；已有配置继续保留，管理员应只指定该账号确实获授权的目录）；`--private-ip IP` 手动指定蒲公英地址；`--port PORT` 固定端口；`--loopback-only` 只提供本机访问；`--skip-daemon-bootstrap` 复用已经运行的该用户 daemon；`--dry-run` 只生成配置、不安装依赖或启动服务。配置覆盖整个 home 时安装器会显示安全警告和收紧建议。首次在共享服务器上部署时，建议先用 `--dry-run` 检查目录和参数格式，再执行正式安装。

### 让 AI 协助安装

如果让电脑上的 Codex、Claude Code 或其他 AI 协助部署，AI 必须同时具备：目标 Linux 账号的终端/SSH 操作权限、访问 GitHub 的网络权限，以及用户明确授予的命令执行权限。仅能打开 GitHub 页面并不能自动登录服务器，也不能替用户执行需要管理员权限的操作。

可以把下面的要求连同本 README 和 [组内部署说明](docs/TEAM_DEPLOYMENT.md) 交给 AI：

```text
请按 Codex PWA 仓库的 README.md 和 docs/TEAM_DEPLOYMENT.md 部署当前 Linux 用户自己的实例。
先检查当前用户名、HOME、Node.js 22+、npm、Codex CLI、codex login status、蒲公英私网 IP 和端口可用性。
不得使用其他 Linux 用户的 home、Codex 凭据或 Web UI 配置；不得把服务监听到公网；不得重启 Linux 服务器或其他用户的 Codex daemon。
缺少 Linux 账号、Codex 登录、蒲公英组网或管理员 linger 权限时先报告，不要猜测或绕过。
确认前提后在本仓库执行 npm run setup，完成后报告实际生成的私网网址、登录用户名和需要管理员执行的命令；不要在聊天记录中复制密码或任何私密文件内容。
```

安装脚本不会创建 Linux 账号、配置蒲公英客户端或替用户取得 `sudo` 权限。多人部署必须由管理员先分配独立 Linux 账号；脚本会在 `4177–4277` 中寻找空闲端口，因此每个人会得到不同的 `IP:端口` 网址。

完整组内部署说明见 [docs/TEAM_DEPLOYMENT.md](docs/TEAM_DEPLOYMENT.md)，不在共享服务器登录个人 GitHub 的发布步骤见 [docs/PUBLISHING.md](docs/PUBLISHING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 让服务在退出 SSH 后继续运行

服务器管理员需要为对应 Linux 账号启用 systemd linger：

```bash
sudo loginctl enable-linger USERNAME
```

这只需要每个账号执行一次。没有 linger 时，用户完全退出服务器后，用户级服务可能停止。

## 当前能力

- 搜索、分页、置顶、重命名、归档和恢复 Codex 任务
- 新建任务、继续对话、停止任务、实时输出和完整运行轨迹回填
- 手机切换 App、SSE 重连和跨端切换后的平滑恢复
- 每任务独立模型、双语推理强度和访问权限设置
- Markdown、LaTeX、表格、代码块、Diff、命令和工具活动
- 生成图片的实时显示、历史恢复、预览和下载
- 服务器文件浏览、搜索、预览和下载
- 工作目录浏览、新建目录和从指定目录创建任务
- 手机相册及普通文件上传
- 审批命令、文件变更和回答 Codex 交互式问题
- 可信设备 90 天、设备列表、重命名和单设备撤销
- 长按任务条目打开管理菜单
- 统一任务操作菜单、归档确认和任务 ID 复制
- Goal 目标状态、暂停/继续/结束/清除与用量展示（由当前 app-server 支持时启用）
- 使用帮助、只读咨询和受控的 UI 改进入口
- 深色/浅色外观；在 HTTPS 或 localhost 下支持完整 PWA 安装和离线外壳
- 与同一 Linux 用户的 Windows Codex Remote 共享持久 daemon

手机 Web UI 和 Windows Codex Remote 可以共享同一 Linux 用户的持久 daemon 和任务历史。同一 daemon 的多个连接并没有按设备划分的独占写入锁：CLI 0.153.2 实测允许另一个连接向当前轮次追加输入，因此发送、审批和中止仍需跨端协调。下述 PWA 队列只管理经过本 Web UI 服务的请求。

若出现“已有 active writer”，先核对两端是否连接同一个 Codex daemon。实测另一个 app-server 进程会被拒绝恢复已由原进程加载的任务，即使原轮次已停止；退订、关闭任务窗口或连接也不保证立即释放占用。“停止实时跟进”仅停止 PWA 的实时订阅，不代表已把写入权交给另一端。当前没有经过协议验证的强制接管接口，不要为了切换任务重启共享 daemon。具体证据与适用版本见[协议核对记录](docs/PROTOCOL_AUDIT.md#真实多连接与跨进程写入实验)。

来自同一 Web UI 服务的发送、追加、中止、审批和问答会按任务串行处理。尚未开始的请求最多等待 30 秒，每任务最多排队 32 条，全局最多保留 1,024 条运行或排队操作；容量不足或等待超时会明确提示本次请求未发送。浏览器断开连接时，仍在排队的请求会被移除；已经开始的操作会继续等待 Codex 的结果，因此断开页面不能作为已发送消息的撤回确认。`/api/status` 的 `mutationQueues` 提供各任务正在处理和等待的数量。

输入框上方会显示本设备正在提交的操作、排队位置，以及同一 PWA 服务已识别到的等待设备。“取消等待”只有在服务器确认请求仍在队列中时可用；已经开始处理的操作不能通过该按钮撤回。取消后保留消息输入和等待期间的新草稿。其他登录设备不能查看或取消该请求；未开启认证时，不可猜测的请求编号仅用于关联请求，不代替设备认证。

主要消息会显示具体时间。消息或通知提供的发送、开始和完成时间优先使用；缺少这些字段时，会标明采用服务器/浏览器接收时间或轮次时间。悬停时间可查看来源以及回复开始、完成时间。SSE 回放保留桥接服务原始接收时间；旧历史中不存在的逐消息时间只能回退显示，不能恢复成未经记录的精确时间。

在 HTTPS 或 localhost 下，可从侧栏“浏览器通知”选择页面通知或可选的后台推送。页面通知需要网页保持运行；配置 Web Push 后，可为可信设备单独开启页面关闭后的任务完成和审批提醒。点击通知会打开对应任务，并保留已有页面中的草稿；部分手机需要先将网页添加到主屏幕。配置步骤、撤销方式、网络要求和验收边界见 [后台推送](docs/WEB_PUSH.md)。私网 HTTP 的原有远程控制功能保持可用。

Web UI 重启或桥接重连后，会从私有状态记录中重新核对已知运行任务；未确认的任务保留“待核实”，不会因为连接失败被判为已完成。即使页面关闭，后台也会定期只读核对这些任务，不自动接管写入。任务范围、存储与实机验收限制见 [任务恢复](docs/TASK_RECOVERY.md)。

维护者可对一个已在运行的任务显式执行 `npm run verify:live-recovery -- /absolute/daemon.sock TASK_ID`。它启动受临时密码保护的独立 Web UI，通过只读转发层验收断线与临时进程重启，保持实际任务和生产服务运行；不会调用任务创建、续写、停止或审批接口。此入口不随常规测试运行，具体前提和验收范围见上述任务恢复文档。

手机侧栏和详情面板支持键盘焦点隔离，操作菜单支持方向键与 Esc；读屏状态提示跟随当前弹窗，新增审批不会清空正在填写的回答。浏览器语义树、主题对比度检查和实机读屏验收边界见 [无障碍核对](docs/ACCESSIBILITY_AUDIT.md)。

发送连接中断时会尝试使用同一请求编号查询结果，不自动重发。服务器在内存中保留最多 128 条结果凭据，有效期 2 分钟，每条响应正文最多 32 KiB；凭据缺失、过期或服务重启都不能证明消息未发送。Windows/CLI 的当前写入设备无法从任务创建来源准确推断，仍按跨端冲突提示处理。

## 日常命令

诊断：

```bash
npm run doctor
```

查看当前用户自己的服务和日志（这些命令不会重启 Linux 服务器或其他用户的服务）：

```bash
systemctl --user status codex-pwa.service codex-pwa-private.socket
journalctl --user -u codex-pwa.service -u codex-pwa-private.service --since "1 hour ago"
```

默认安装使用 `shared-daemon`，只重启当前用户的 Web UI 不会重启 Codex daemon 或其中的任务（手动改成 `isolated` 模式时，不要在任务运行中重启）：

```bash
systemctl --user restart codex-pwa.service
```

若私网入口仍不可访问，再检查 `systemctl --user status codex-pwa-private.socket`；不要重启服务器或共享 Codex daemon。

更新：

```bash
bash scripts/update-user.sh
```

ZIP 安装更新：

```bash
bash scripts/update-user.sh --zip /path/to/codex-pwa-vX.Y.Z.zip
```

ZIP 更新先校验包内文件清单；Git 更新复制完整安装到独立候选目录，再按当前分支的 upstream 执行 fast-forward 更新，保留原有 Git 配置和被忽略的本机文件。Git 安装须为干净的独立 checkout；有关联 worktree、分叉历史、未配置 upstream 或 detached HEAD 时会拒绝自动替换。候选测试期间若原目录出现 Git 本地改动或 HEAD 变化，也会停止更新。已是最新提交时不重启服务。

两种方式都会在候选目录安装依赖并测试；切换目录后重启本用户的 PWA，核对健康状态、运行版本和完整 Service Worker 文件。失败会恢复旧目录并重新核对旧版本健康状态。若旧服务也无法启动，会明确报告恢复未确认并保留失败候选。更新互斥锁可防止两个更新进程同时替换同一安装；配置、密码和可信设备保留在原配置目录。

维护者可运行 `npm run release:verify` 验证开发树。具备用户 systemd、已运行的 Codex daemon 和 npm 离线依赖缓存时，还可显式运行 `npm run verify:systemd`，在独立目录和临时 unit 中验收完整应用启动、登录、重启与异常退出恢复；脚本保持现有服务运行并清理自己的测试环境。覆盖范围与正式发布剩余检查见 [发布生命周期验收](docs/RELEASE_ACCEPTANCE.md)。

修改 Web UI 密码：

```bash
bash scripts/set-password.sh
```

卸载 PWA 服务但保留配置：

```bash
bash scripts/uninstall-user.sh
```

## 手动配置

安装程序将运行时配置写入：

```text
~/.config/codex-pwa/codex-pwa.env
```

主要变量：

- `CODEX_PWA_HOST`：Node 服务监听地址，推荐保持 `127.0.0.1`
- `CODEX_PWA_PORT`：该用户的独立端口
- `CODEX_PWA_ROOTS`：允许访问的绝对目录；多个目录用冒号分隔（目录名本身不要包含冒号）
- `CODEX_PWA_ROOTS_FILE`：可选的 Web UI 动态授权目录记录，默认是 `~/.config/codex-pwa/authorized-roots.json`；文件权限为 600，配置中的基础目录不能从 Web UI 移除
- `CODEX_BIN`：该用户的 Codex CLI 路径
- `CODEX_HOME`：该用户的 Codex 数据目录
- `CODEX_PWA_APP_SERVER_MODE`：共享持久 daemon 时使用 `shared-daemon`
- `CODEX_PWA_DAEMON_SOCKET`：该用户自己的 app-server control socket
- `CODEX_PWA_EVENT_REPLAY_FILE`：可选的 SSE 回放文件；生产默认写入 `CODEX_HOME/pwa-event-replay.jsonl`，文件权限为 600 且受有界事件窗口限制
- `CODEX_PWA_PASSWORD_FILE`：Web UI 登录密码文件
- `CODEX_PWA_USERNAME_FILE`：Web UI 登录用户名文件，默认与密码文件同目录的 `access-username`
- `CODEX_PWA_SESSION_FILE`：可信设备记录
- `CODEX_PWA_INSTANCE_NAME`：侧栏显示的实例名称
- `CODEX_PWA_NETWORK_LABEL`：侧栏显示的网络入口说明

`.env.example` 仅用于说明，真实凭据不要放进仓库。

## 多人部署的隔离边界

公开 GitHub 仓库的可读权限与服务器访问权限是两回事。克隆仓库不会让同学获得服务器权限，也不会让同学看到其他用户的任务或文件。真正的隔离依赖每人独立的 Linux 账号、home、Codex 凭据、daemon、PWA 端口、登录凭据和 `CODEX_PWA_ROOTS`。

不要让多人共用同一个 PWA 网址或同一个 Linux 账号。若某人的账号尚未建立、蒲公英 IP 无法检测、端口范围已耗尽或 `systemd-socket-proxyd` 不可用，应由管理员处理后再安装；不要通过把服务监听到 `0.0.0.0` 来绕过这些问题。

## 无蒲公英或其他私网

```bash
npm run setup -- --loopback-only
```

这种模式仅监听 `127.0.0.1`，需要 SSH 隧道或由管理员配置受信任的 HTTPS 反向代理。不要把 PWA 或未认证的 app-server socket 直接暴露到公网。

普通蒲公英 IP 上的 `http://` 页面可正常远程控制和断线自动重连，也可以创建桌面网页快捷方式；但远程 HTTP 通常不能注册 Service Worker，因此不等同于完整的离线 PWA，而且流量没有 HTTPS 加密。完整安装和离线外壳需要手机信任的 HTTPS 入口。

安装器会给 Web UI 进程设置 `MemoryHigh=768M` 和 `MemoryMax=1G`，避免异常超长历史或损坏数据无上限占用服务器内存。共享 Codex daemon 运行在独立服务中，不受这个 Web UI 限额影响。

如果管理员使用 HTTPS 反向代理，代理必须把普通 HTTP 请求转发到本用户的 `127.0.0.1:CODEX_PWA_PORT`，允许 `/api/events` 的 SSE 长连接并关闭响应缓冲、避免短超时；不要把 Unix socket 或 app-server 端口直接暴露给手机或公网。

## 开发与测试

后端任务、诊断、订阅及协议适配和前端任务操作、通知、视图的职责划分见 [模块边界审计](docs/PROTOCOL_AUDIT.md#模块边界审计r082026-09-16)。模块通过显式依赖组装，维护时应保留认证、目录授权、审批身份与写入队列的调用顺序。

界面文案统一在 `public/ui-copy.js` 管理；修改后运行 `npm run copy:sync` 同步静态页面。`npm run check` 会检查文案是否同步，键、占位符和静态标记的约定见 [文案维护说明](docs/UI_COPY.md)。

```bash
npm ci
npm run check
```

`npm run release:verify` 会运行完整检查，再检查暂存发布包的文件清单、JavaScript 静态相对模块依赖、符号链接、敏感信息和 SHA-256 清单。随后将完整包复制到临时目录，离线安装依赖并启动真实服务，核对登录、CSRF、授权目录、静态资源、Service Worker 缓存列表和审批身份。它适用于未提交的开发树，不会生成正式 ZIP、提交、打标签或推送。模块检查只解析源码；运行验收使用独立配置和模拟 daemon，详细边界见 [发布生命周期验收](docs/RELEASE_ACCEPTANCE.md)。完整检查中的包故障回归和发布运行验收均需要 npm 依赖缓存，可先通过上述 `npm ci` 准备；缓存缺失会失败，不自动联网安装。

`npm run release:candidate` 执行相同检查后，将本地候选 ZIP、`CANDIDATE.json` 和 `SHA256SUMS.txt` 保存在独立的 `dist/candidate-*` 目录，便于审阅和隔离安装/更新验收。元数据记录源 HEAD、是否有未提交改动，以及 ZIP、包内清单和 Service Worker 摘要；校验文件覆盖 ZIP 与元数据。候选保持当前包版本，因此还需结合摘要区分开发快照；它不是正式 Release，不创建提交、标签或 Git bundle，也不修改运行服务。正式打包仍要求干净工作树和指向 HEAD 的版本标签。

当前协议兼容基线来自 Codex CLI/app-server `0.148.0`；已用该版本和 `0.153.2` 的实际 CLI 完成隔离 PWA 启动、模型列表与临时状态库版本切换验收。维护者可用 `npm run verify:cli -- /path/to/old/codex /path/to/new/codex` 复现，协议矩阵和支持边界见 [CLI 兼容验收](docs/CLI_COMPATIBILITY.md)。这两个版本号是已验证基线，不是对未来 CLI 的锁定要求；升级 Codex 后应先运行 `npm run doctor` 和 `npm run check`，并在出现异常时保留 `journalctl --user` 日志。任务恢复会优先采用新版轻量分页方式，并为旧版参数保留兼容回退；Goal 等实验接口在不受支持时会自动降级。

所有源代码采用 MIT License。`npm run release:local` 会生成不含开发历史、凭据、任务和依赖目录的干净 ZIP，以及从已清洗快照重新初始化的单提交 Git bundle。不要直接分享现有工作仓库、其 `.git` 目录或由该开发仓库直接导出的 bundle。

维护者如需从共享服务器自动发布，可为单一 GitHub 仓库配置专用的写入 Deploy Key，并使用完全独立的干净镜像：

```bash
bash scripts/publish-mirror.sh --mirror "$HOME/codex-pwa-public" --push
```

该命令只会把刚刚通过检查和隐私扫描的 ZIP 快照同步进镜像，以原子操作推送 `main` 与新标签。密钥必须通过镜像本地的 `core.sshCommand` 绑定，不能放入项目文件或全局 `ssh-agent`。完整边界见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 官方接口依据

PWA 使用 Codex app-server 的 Unix socket JSON-RPC/WebSocket 传输。官方 OpenAI 文档说明 `codex app-server --listen unix://` 可在默认 app-server control socket 接受连接；`codex app-server daemon bootstrap`/`start` 用于 SSH 场景下的持久 daemon 管理。参考：

- [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server#protocol)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control)

## 版本与回滚

- `v0.10.1`：历史生成图片严格归位
- `v0.11.0`：组内分发版、每用户一键部署、动态实例信息和安全文档
- `v0.11.1`：私网 IP 尚未就绪时允许 systemd 预先绑定，避免服务器启动后入口永久停在 failed 状态
- `v0.12.0`：统一任务菜单层级、归档确认、任务 ID 复制、Goal 状态管理和使用帮助入口
- `v0.13.0`：断网自动恢复、完整活动历史、Goal 创建/编辑、服务器文件管理和 Markdown/媒体预览
- `v0.14.0`：移动端文件菜单、历史对话节点、任务/Goal 布局和使用帮助交互优化
- `v0.15.0`：手机端菜单/标题对齐、文件根目录显示和帮助文案细节优化
- `v0.16.0`：手机视口居中和菜单选中态细节修正
- `v0.16.1`：文件菜单选中背景细节修正
- `v0.17.0`：发布候选版稳定性、安全边界、超长历史与 ZIP 生命周期完善
- `v0.17.1`：历史节点滚动/排版、回复图片原位预览与 Codex 0.153.2 适配
- `v0.17.2`：历史节点初次打开时显示明确加载状态
- `v0.18.0`：浮动菜单、归档状态、超时核对、内存边界和安装更新可靠性改进
- `v0.18.1`：精简会话顶部操作，并统一列表整行高亮
- `v0.18.2`：发布恢复、并发状态、文件操作、历史内存及离线缓存稳定性改进
- `v0.18.3`：历史节点按真实时间位置跳转、上下文折叠与双向加载
- `v0.18.4`：统一顶部操作提示，历史节点反馈贴合上下文横幅并优化标题栏间距
- `v0.18.5`：确认操作高对比配色与长耗时操作统一加载反馈
- `v0.18.6`：修复历史节点定位提示被模态框遮挡的问题
- `v0.18.7`：保留未列入模型目录的任务模型，并兼容新版任务设置响应
- `v0.18.8`：修复 GitHub Actions 环境差异，并加入隔离镜像自动发布链路
- `v0.18.9`：增强 GitHub Actions 中 Chrome 启动的兼容性与可诊断性
- `v0.18.10`：增加需验证旧凭据的用户名或密码修改入口，并在修改后撤销全部可信设备
- `v0.18.11`：递增 PWA 缓存版本，确保已安装客户端及时更新资源
- `v0.18.12`：完善公开仓库、AI 辅助部署和多人隔离文档
- `v0.18.13`：补充认证、安装目录、校验、排障、HTTPS/SSE 和跨端并发说明
- `v0.18.14`：修复 systemd 安装路径格式，并增加启动前 unit 校验

Git 发布可使用版本标签。Git 和 ZIP 更新均按安装目录分别保留最近三份可恢复的旧程序目录，不清理其他安装或归属未明确的历史备份。出现问题时只需恢复程序目录并重启该用户自己的 `codex-pwa.service`；不需要重启 Linux、共享 Codex daemon 或其他用户的任务。隔离安装、更新和回滚验收范围见 [发布验收记录](docs/RELEASE_ACCEPTANCE.md)。
