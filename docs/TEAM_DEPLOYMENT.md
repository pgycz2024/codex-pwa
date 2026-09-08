# 组内分享与部署

推荐方式是把源码放进一个私有 GitHub、GitLab 或 Gitea 仓库，然后让每位同学在自己的 Linux 账号中独立安装。不要让多人登录同一个 PWA 实例。

共享服务器不应保存维护者的个人 GitHub 登录。隐私优先做法是在个人电脑下载发布 ZIP 后再传给对应 Linux 账号；必须直接克隆私有仓库时，只配置限定到该仓库的只读 Deploy Key。

## 管理员一次性准备

1. 确保每位同学有独立的 Linux 账号和 home 目录。
2. 将同学的手机加入同一个蒲公英私网。
3. 确保每位同学能在自己的账号中运行 Node.js 22、npm 和 Codex CLI。
4. 如果希望退出 SSH 后服务仍持续运行，为该账号启用 systemd linger：

   ```bash
   sudo loginctl enable-linger USERNAME
   ```

5. 每位用户使用不同的高位端口，例如 4177、4178、4179。安装脚本会自动寻找空闲端口。

## 每位同学执行

建议在该账号没有正在运行的 Codex 任务时进行第一次安装。

可以从干净 ZIP 解压安装，也可以从经过清理的私有仓库克隆。ZIP 示例：

```bash
unzip codex-pwa-vX.Y.Z.zip
cd codex-pwa-vX.Y.Z
npm run setup
```

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

## 日常维护

检查状态：

```bash
cd ~/codex-pwa
npm run doctor
```

更新：

```bash
cd ~/codex-pwa
bash scripts/update-user.sh
```

ZIP 安装使用：

```bash
cd /path/to/current/codex-pwa-vX.Y.Z
bash scripts/update-user.sh --zip /path/to/new/codex-pwa-vX.Y.Z.zip
```

修改 Web UI 密码：

```bash
cd ~/codex-pwa
bash scripts/set-password.sh
```

也可以直接在 Web UI 登录页下方，或“已登录设备管理”底部，点击“修改用户名或密码”。系统会要求验证当前用户名和密码；保存后所有可信设备会失效。旧安装没有单独的用户名文件时，当前用户名默认为 `codex`。

卸载 PWA 服务但保留凭据和任务：

```bash
cd ~/codex-pwa
bash scripts/uninstall-user.sh
```

卸载 PWA 服务并删除 PWA 密码及可信设备记录：

```bash
cd ~/codex-pwa
bash scripts/uninstall-user.sh --purge-config
```

卸载脚本不会删除 Codex 登录、daemon、历史任务、源码仓库或项目文件。

## 没有蒲公英时

可以执行：

```bash
npm run setup -- --loopback-only
```

此时服务只监听 `127.0.0.1`，需要 SSH 隧道或由管理员配置受信任的 HTTPS 反向代理。不要为了省事直接把 app-server socket 或 PWA 暴露到公网。

## HTTP 与完整 PWA 的区别

蒲公英 IP 上的普通 `http://` 页面可以作为手机网页或桌面快捷方式使用，但远程 HTTP 通常不属于浏览器安全上下文，Service Worker、离线外壳和标准 PWA 安装能力可能不可用。断线后的在线自动重连不受此限制。

若需要真正的 PWA 安装和离线外壳，请在受控私网中配置手机信任的 HTTPS 入口；仍然不要把 Web UI 或 app-server 直接暴露到公网。
