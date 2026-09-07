# Codex PWA

一个面向手机和桌面浏览器的 Codex Remote Web UI，通过本机 `codex app-server` 操作 Linux 服务器。当前版本为 `0.18.9`。

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

前提：Linux 账号中已经安装 Node.js 22+、npm 和 Codex CLI，并已完成 `codex login`。

干净 ZIP 分发包可以解压到该 Linux 用户有写权限的任意目录：

```bash
unzip codex-pwa-vX.Y.Z.zip
cd codex-pwa-vX.Y.Z
npm run setup
```

也可以从经过隐私清洗的私有 Git 仓库克隆后执行 `npm run setup`。

安装程序会自动：

- 安装 Node 依赖；
- 检查该用户自己的 Codex 登录；
- 通过 `codex app-server daemon bootstrap/start` 安装并启动持久 daemon；
- 默认只允许访问该用户自己的 home；
- 从 4177–4277 自动选择空闲端口；
- 检测 `oray_vnc` 蒲公英 IP；
- 让 Node 服务继续只监听 `127.0.0.1`，再用 systemd socket proxy 仅在私网 IP 暴露所选端口；
- 生成独立的 Web UI 密码；
- 启动服务并执行 HTTP 健康检查。

安装结束会显示手机网址、登录用户名 `codex` 和首次密码。

第一次安装最好在该用户没有正在运行的 Codex 任务时进行，因为安装程序需要建立该用户自己的持久 daemon。已有特殊 daemon 配置的用户可以使用 `--skip-daemon-bootstrap`。

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

## 日常命令

诊断：

```bash
npm run doctor
```

更新：

```bash
bash scripts/update-user.sh
```

ZIP 安装更新：

```bash
bash scripts/update-user.sh --zip /path/to/codex-pwa-vX.Y.Z.zip
```

新版本会先在临时目录安装依赖并测试，健康检查通过后才切换；失败自动恢复旧版本。

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
- `CODEX_PWA_ROOTS`：允许访问的绝对目录；多个目录用冒号分隔
- `CODEX_BIN`：该用户的 Codex CLI 路径
- `CODEX_HOME`：该用户的 Codex 数据目录
- `CODEX_PWA_APP_SERVER_MODE`：共享持久 daemon 时使用 `shared-daemon`
- `CODEX_PWA_DAEMON_SOCKET`：该用户自己的 app-server control socket
- `CODEX_PWA_PASSWORD_FILE`：Web UI 登录密码文件
- `CODEX_PWA_SESSION_FILE`：可信设备记录
- `CODEX_PWA_INSTANCE_NAME`：侧栏显示的实例名称
- `CODEX_PWA_NETWORK_LABEL`：侧栏显示的网络入口说明

`.env.example` 仅用于说明，真实凭据不要放进仓库。

## 无蒲公英或其他私网

```bash
npm run setup -- --loopback-only
```

这种模式仅监听 `127.0.0.1`，需要 SSH 隧道或由管理员配置受信任的 HTTPS 反向代理。不要把 PWA 或未认证的 app-server socket 直接暴露到公网。

普通蒲公英 IP 上的 `http://` 页面可正常远程控制和断线自动重连，也可以创建桌面网页快捷方式；但远程 HTTP 通常不能注册 Service Worker，因此不等同于完整的离线 PWA。完整安装和离线外壳需要手机信任的 HTTPS 入口。

安装器会给 Web UI 进程设置 `MemoryHigh=768M` 和 `MemoryMax=1G`，避免异常超长历史或损坏数据无上限占用服务器内存。共享 Codex daemon 运行在独立服务中，不受这个 Web UI 限额影响。

## 开发与测试

```bash
npm ci
npm run check
```

当前协议兼容基线来自 Codex CLI/app-server `0.148.0`，当前完整回归与生成协议校验使用 `0.153.2`。任务恢复会优先采用新版轻量分页方式，并为旧版参数保留兼容回退。升级 Codex 后应先运行 `npm run doctor` 和 `npm run check`；Goal 等实验接口在不受支持时会自动降级。

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

Git 发布可使用版本标签。ZIP 更新会保留最近三份可恢复的旧程序目录。出现问题时只需恢复程序目录并重启该用户自己的 `codex-pwa.service`；不需要重启 Linux、共享 Codex daemon 或其他用户的任务。
