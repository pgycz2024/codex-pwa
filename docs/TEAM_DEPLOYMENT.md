# 组内分享与部署

当前推荐使用 GitHub 上的公开清洗发布仓库 [`pgycz2024/codex-pwa`](https://github.com/pgycz2024/codex-pwa)，让每位同学在自己的 Linux 账号中独立安装。公开仓库只提供程序、文档和测试，不提供服务器访问权；不要让多人登录同一个 PWA 实例。

共享服务器不应保存维护者的个人 GitHub 登录。普通组员可以直接从公开仓库克隆，或在自己的电脑下载 Release ZIP 后再传给对应 Linux 账号。内部开发仓库仍应保持私有，不能把内部开发仓库直接公开。

## 管理员一次性准备

1. 确保每位同学有独立的 Linux 账号和 home 目录。
2. 将同学的手机加入同一个蒲公英私网。
3. 确保每位同学能在自己的账号中运行 Node.js 22、npm 和 Codex CLI，并在该账号中完成自己的 `codex login`。PWA 会复用 Codex CLI 当前认证，包括 API Key 登录；不会替用户登录 ChatGPT 或上传凭据。
4. 如果希望退出 SSH 后服务仍持续运行，为该账号启用 systemd linger：

   ```bash
   sudo loginctl enable-linger USERNAME
   ```

5. 确认服务器已安装 `systemd-socket-proxyd`，并预留 `4177–4277` 中的私网端口。安装脚本会自动寻找空闲端口，也可以由管理员为每人固定分配端口。

## 每位同学执行

建议在该账号没有正在运行的 Codex 任务时进行第一次安装。

可以从干净 ZIP 解压安装，也可以从公开仓库克隆。ZIP 示例：

```bash
unzip codex-pwa-vX.Y.Z.zip
cd codex-pwa-vX.Y.Z
npm run setup
```

公开仓库克隆示例：

```bash
git clone https://github.com/pgycz2024/codex-pwa.git
cd codex-pwa
npm run setup
```

需要固定版本时，可使用 `git clone --branch v0.18.14 --depth 1 https://github.com/pgycz2024/codex-pwa.git`，或从 GitHub Releases 下载同名版本的 ZIP。仓库克隆不需要 GitHub 登录。

从 Release ZIP 安装前可在同一目录验证完整性：

```bash
sha256sum --ignore-missing -c SHA256SUMS-vX.Y.Z.txt
```

如果只下载 ZIP，`--ignore-missing` 会跳过尚未下载的 Git bundle；ZIP 对应条目必须显示 `OK`。如果同时下载了 ZIP 和 bundle，两个条目都应显示 `OK`；校验失败时不要解压或执行其中的安装脚本。

安装脚本会：

- 检查 Node.js 和 Codex 登录；
- 安装前端依赖；
- 使用 `codex app-server daemon bootstrap/start` 建立该用户自己的持久 daemon；
- 将文件权限限制在该用户指定的目录，默认是自己的 home；
- 自动选择端口；
- 检测 `oray_vnc` 蒲公英 IP，并创建仅绑定该私网 IP 的 systemd socket proxy；
- 使用 `FreeBind` 预先绑定私网地址，避免虚拟网卡晚于用户服务启动时入口失效；
- 生成独立的 Web UI 密码；
- 启动并验证 PWA 服务。

安装结束会打印手机访问网址、用户名 `codex` 和首次密码。首次登录后可记住设备 90 天；也可以在登录页或“已登录设备管理”中修改用户名和密码。修改成功后所有设备都需要重新登录。

安装器会在 `4177–4277` 中选择空闲端口，并输出类似 `http://蒲公英IP:4178` 的网址。每位用户的端口、密码和文件根目录都不同，因此手机必须打开自己那一行网址。若自动检测不到蒲公英 IP，可以使用 `npm run setup -- --private-ip SERVER_PRIVATE_IP`；端口冲突时使用 `npm run setup -- --port PORT`。需要限制文件访问范围时使用 `npm run setup -- --root /absolute/authorized/path`，只指定该账号获授权的目录；如果想先只检查配置而不启动服务，可执行 `npm run setup -- --dry-run`。

管理员还必须为每个实际使用的私网端口放行防火墙。以蒲公英接口为例，将安装输出的地址和端口代入：

```bash
sudo ufw allow in on oray_vnc to SERVER_PRIVATE_IP port PORT proto tcp comment 'Codex PWA via PgyVPN'
```

安装器不会替用户修改 UFW。若服务本机健康检查正常但手机一直加载，优先检查这条规则是否存在，再检查手机是否连接同一蒲公英组网；不要把服务改为监听 `0.0.0.0`。

### 给 AI 的执行边界

让 AI 部署时，应明确告诉它：当前终端已经登录到目标 Linux 用户；先检查 `id -un`、`echo "$HOME"`、`node --version`、`codex login status` 和私网 IP，再执行安装。AI 不会自动创建 Linux 账号、安装蒲公英客户端、取得 `sudo` 权限或替其他用户配置服务。缺少这些前提时，应先报告并等待管理员处理。

## 日常维护

检查状态：

```bash
cd /path/to/your/codex-pwa
npm run doctor
```

更新：

```bash
cd /path/to/your/codex-pwa
bash scripts/update-user.sh
```

ZIP 安装使用：

```bash
cd /path/to/current/codex-pwa-vX.Y.Z
bash scripts/update-user.sh --zip /path/to/new/codex-pwa-vX.Y.Z.zip
```

修改 Web UI 密码：

```bash
cd /path/to/your/codex-pwa
bash scripts/set-password.sh
```

也可以直接在 Web UI 登录页下方，或“已登录设备管理”底部，点击“修改用户名或密码”。系统会要求验证当前用户名和密码；保存后所有可信设备会失效。旧安装没有单独的用户名文件时，当前用户名默认为 `codex`。

卸载 PWA 服务但保留凭据和任务：

```bash
cd /path/to/your/codex-pwa
bash scripts/uninstall-user.sh
```

卸载 PWA 服务并删除 PWA 密码及可信设备记录：

```bash
cd /path/to/your/codex-pwa
bash scripts/uninstall-user.sh --purge-config
```

卸载脚本不会删除 Codex 登录、daemon、历史任务、源码仓库或项目文件。

查看服务状态和最近日志：

```bash
systemctl --user status codex-pwa.service codex-pwa-private.socket
journalctl --user -u codex-pwa.service -u codex-pwa-private.service --since "1 hour ago"
```

默认安装使用 `shared-daemon`，只重启当前账号的 PWA 服务可使用 `systemctl --user restart codex-pwa.service`，不会重启共享 Codex daemon 或其中的任务；手动改成 `isolated` 模式时，不要在任务运行中重启。上述操作不会重启 Linux 服务器或其他账号的服务。

## 安装后的首次使用

1. 在手机上登录蒲公英并确认已加入服务器所在的同一组网。
2. 用安装输出的完整 `http://私网IP:端口` 地址打开 Chrome；不要只输入服务器 IP，也不要使用其他同学的端口。
3. 使用安装输出的用户名和首次密码登录，并立即在“修改用户名或密码”中设置个人凭据。
4. 将页面加入收藏或创建桌面快捷方式。远程 HTTP 可以在线使用和自动重连，但完整 PWA 离线外壳通常需要受信任的 HTTPS。

如果页面无法打开，先在实际安装目录运行 `npm run doctor`，再确认蒲公英连接、私网 IP、端口和 `codex-pwa-private.socket` 状态。不要为了排障把服务改为监听公网。

## 没有蒲公英时

可以执行：

```bash
npm run setup -- --loopback-only
```

此时服务只监听 `127.0.0.1`，需要 SSH 隧道或由管理员配置受信任的 HTTPS 反向代理。不要为了省事直接把 app-server socket 或 PWA 暴露到公网。

## HTTP 与完整 PWA 的区别

蒲公英 IP 上的普通 `http://` 页面可以作为手机网页或桌面快捷方式使用，但远程 HTTP 通常不属于浏览器安全上下文，Service Worker、离线外壳和标准 PWA 安装能力可能不可用，而且流量没有 HTTPS 加密。断线后的在线自动重连不受此限制。

若需要真正的 PWA 安装和离线外壳，请在受控私网中配置手机信任的 HTTPS 入口。反向代理还必须支持 `/api/events` 的 SSE 长连接并关闭缓冲、避免短超时；仍然不要把 Web UI 或 app-server 直接暴露到公网。

手机 Web UI 和 Windows Codex Remote 可以看到同一任务历史，但同一个任务同时只能有一个活动写入者。不要在两端同时发送消息或审批；切换前先完成并关闭上一端的任务视图。若出现 `already has an active writer`，先完全关闭上一端，等待几秒后刷新，不要为此重启服务器或共享 daemon。
