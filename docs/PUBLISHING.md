# 隐私优先的发布流程

本项目默认假设 Linux 服务器是多人共用环境。发布者的 GitHub 登录、Token 和 SSH 私钥不得进入服务器。

## 发布边界

- Linux 服务器只负责测试和生成已清洗的发布文件；
- 发布文件通过已有 SSH 连接下载到发布者的 Windows 电脑；
- GitHub 仓库的创建、登录和推送全部在 Windows 完成；
- 不上传服务器上现有项目的 `.git` 目录或开发历史；
- 第一次发布建议使用 GitHub **Private** repository。

旧开发历史可能包含已经删除的服务器地址、个人目录或项目名称。即使当前文件已经清理，普通 `.gitignore` 也不能清除历史对象，因此不要直接推送开发仓库。

## 一、在 Linux 服务器生成发布文件

维护者在完成提交并给当前提交添加版本标签后运行：

```bash
cd /path/to/codex-pwa
npm run release:local
```

`dist/` 将生成：

- `codex-pwa-vX.Y.Z.zip`：给普通用户解压安装的源码包；
- `codex-pwa-vX.Y.Z-clean-git.bundle`：仅含清洗后初始提交和版本标签的 Git 引导包；
- `SHA256SUMS-vX.Y.Z.txt`：上述两个文件的 SHA-256 校验值。

构建过程会运行完整测试、扫描常见密钥和已知私人部署信息、拒绝符号链接，并确保版本标签与当前提交一致。Git bundle 是从已清洗暂存目录重新初始化生成的，不包含服务器开发仓库历史。

## 二、下载到 Windows

在 Windows PowerShell 中进入希望保存发布文件的目录，然后使用已有 SSH 登录下载：

```powershell
scp LINUX_USER@SERVER_IP:/path/to/codex-pwa/dist/codex-pwa-vX.Y.Z.zip .
scp LINUX_USER@SERVER_IP:/path/to/codex-pwa/dist/codex-pwa-vX.Y.Z-clean-git.bundle .
scp LINUX_USER@SERVER_IP:/path/to/codex-pwa/dist/SHA256SUMS-vX.Y.Z.txt .
```

可在 Windows 验证文件哈希：

```powershell
Get-FileHash .\codex-pwa-vX.Y.Z.zip -Algorithm SHA256
Get-FileHash .\codex-pwa-vX.Y.Z-clean-git.bundle -Algorithm SHA256
Get-Content .\SHA256SUMS-vX.Y.Z.txt
```

显示的哈希应与校验文件对应条目完全一致。

## 三、在 Windows 建立干净 Git 项目

推荐直接从 clean Git bundle 克隆：

```powershell
git clone .\codex-pwa-vX.Y.Z-clean-git.bundle codex-pwa
cd .\codex-pwa
git log --oneline --all
```

这里应只有一个初始提交和当前版本标签。服务器上的旧开发历史不会出现。

如果 Windows 尚未配置提交身份，可启用 GitHub 邮箱隐私保护并使用 GitHub 提供的 `noreply` 邮箱：

```powershell
git config user.name "YOUR_GITHUB_NAME"
git config user.email "YOUR_GITHUB_NOREPLY_EMAIL"
```

## 四、从 Windows 上传到 GitHub

1. 在 GitHub 网页新建一个空的 **Private** repository，例如 `codex-pwa`；
2. 不要让 GitHub 自动生成 README、`.gitignore` 或 License；
3. 在 Windows 项目目录中把 bundle 的本地地址换成 GitHub 地址；
4. 推送 `main` 和版本标签。

使用 HTTPS 地址示例：

```powershell
git remote set-url origin https://github.com/YOUR_USER_OR_ORG/codex-pwa.git
git push -u origin main
git push origin vX.Y.Z
```

Windows 的 Git Credential Manager 或 VS Code 会使用 Windows 上的 GitHub 登录。服务器不会接触这些凭据。

也可以在 VS Code 中打开 `codex-pwa` 文件夹，通过“源代码管理”界面发布分支。上传后在 GitHub 的 Releases 页面为 `vX.Y.Z` 创建 Release，并附加 ZIP 与 `SHA256SUMS` 文件。

## 五、组员安装

不希望在共享服务器保存 GitHub 凭据的组员，应在自己的电脑下载 ZIP，再通过 SSH 传到服务器：

```bash
unzip codex-pwa-vX.Y.Z.zip
cd codex-pwa-vX.Y.Z
npm run setup
```

愿意为单个私有仓库配置只读 Deploy Key 的组员，也可以直接克隆 GitHub 仓库；不要在共享服务器保存能够访问多个私人仓库的个人 SSH Key。

## 六、后续版本

后续仍在 Linux 服务器生成新的 ZIP 和 clean Git bundle，再下载到 Windows 审阅。Windows 上的 GitHub 仓库作为对外分享时间线，服务器上的内部开发仓库继续保持私有且不上传。
