# 隐私优先的发布流程

本项目默认假设 Linux 服务器是多人共用环境。发布者的 GitHub 登录、Token 和个人 SSH 私钥不得进入服务器。默认采用 Windows 上传；需要自动化时，也可以使用仅限一个仓库的 Deploy Key 和独立干净镜像。

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

## 六、可选：仓库专用 Deploy Key 自动发布

自动发布不得给开发仓库添加 GitHub remote。推荐结构：

```text
私有开发仓库 → 测试与隐私扫描 → 干净 ZIP → 独立发布镜像 → GitHub
```

安全要求：

- Deploy Key 只绑定一个 GitHub 仓库，按发布需要开启写权限；
- 私钥不加入全局 `ssh-agent`，只通过发布镜像本地的 `core.sshCommand` 使用；
- 使用经过核验的独立 `UserKnownHostsFile` 和 `StrictHostKeyChecking=yes`；
- 发布镜像必须与私有开发仓库位于不同目录；
- 不允许 force-push，不移动旧标签；分支和标签必须原子推送；
- GitHub Actions 只有 Release 工作流获得当前仓库的 `contents: write`，普通检查保持只读。

完成一次性 Deploy Key 和镜像配置后，在已经提交并标记新版本的私有开发仓库运行：

```bash
bash scripts/publish-mirror.sh --mirror "$HOME/codex-pwa-public" --push
```

脚本会重新运行完整测试、生成并校验发布文件、解压验证内部清单，只将已清洗 ZIP 的内容同步进镜像，然后原子推送 `main` 与版本标签。GitHub 收到标签后会再次运行相同测试，全部通过才创建 Release 并附加 ZIP、clean Git bundle 和 SHA-256 校验文件。

撤销服务器发布权限只需在 GitHub 仓库的 `Settings → Deploy keys` 删除对应密钥，并删除服务器上的专用私钥。仓库其他内容和个人账号凭据不受影响。

## 七、后续版本

后续可以继续在 Linux 服务器生成新的 ZIP 和 clean Git bundle，再下载到 Windows 审阅和推送；也可以使用上述隔离镜像自动发布。无论采用哪种方式，服务器内部开发仓库都继续保持私有且不直接上传。
