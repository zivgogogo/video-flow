# video-flow Agent 安装与启动指南

本文档面向可以执行终端命令的 AI Agent，也可供人工按步骤操作。目标是从一个干净的目录开始，完成 video-flow 的克隆、依赖安装、构建、启动和访问验证。

## 给 Agent 的执行要求

1. 按本文档执行，不要只给出命令而不运行；每一步失败时先根据错误信息处理，不要跳过构建或直接宣称安装成功。
2. 默认安装源码版并使用 Bun。macOS、Ubuntu / Debian 可直接执行；Windows 请使用 WSL2 的 Ubuntu 环境，或改用文末的 Docker 方式。
3. 安装需要访问 GitHub、Bun 和系统软件源。不要使用来源不明的镜像、脚本或依赖版本。
4. 不得删除或覆盖已有项目、未提交修改及 `data/` 目录。目标目录已存在时，先检查远程地址和工作区状态；有未提交修改时停止并询问用户，禁止执行 `git reset --hard`、`git clean -fd` 或强制推送。
5. 安装和启动不要求模型 API Key。不要索取、生成或写入任何真实 API Key；需要生成图片或视频时，由用户在应用设置中自行配置。
6. 不要杀死无法确认归属的进程，不要向公网开放 3000 端口。远程服务器仅通过防火墙、安全组、SSH 隧道或带认证的反向代理提供访问。
7. 完成后报告安装目录、Git 分支与提交、Bun 版本、访问地址、运行中的进程或终端会话，以及实际执行的验证结果。构建成功不等于服务已经启动。

## 1. 准备环境

必需软件：

- Git
- Bun **1.4.3**，与仓库 `packageManager` 版本一致
- FFmpeg，供音视频处理使用
- Linux 还需要 `curl`、`unzip` 和 CA 证书

### macOS

已安装 Homebrew 时：

```sh
brew install git ffmpeg
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.3"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

### Ubuntu / Debian（包括 WSL2）

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates git curl unzip ffmpeg
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.3"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

没有 `sudo` 权限时，由用户先安装系统依赖，不要反复提权。新终端中如果找不到 `bun`，重新执行上面的两行 `export`，或将它们加入当前用户的 shell 配置。

确认环境：

```sh
git --version
bun --version
ffmpeg -version
```

`bun --version` 应输出 `1.4.3`。

## 2. 克隆项目

进入希望保存项目的父目录，然后执行：

```sh
git clone https://github.com/zivgogogo/video-flow.git
cd video-flow
git checkout master
```

以下命令默认都位于仓库根目录，即包含 `package.json`、`bun.lock` 和 `apps/` 的目录。

如果 `video-flow` 目录已经存在，不要重复克隆或覆盖。先执行：

```sh
cd video-flow
git remote get-url origin
git status --short
```

确认 `origin` 是 `https://github.com/zivgogogo/video-flow.git`，且状态输出为空后，才可用 `git pull --ff-only origin master` 更新。状态非空时保留现场并询问用户。

## 3. 安装依赖并构建整个项目

```sh
bun install --frozen-lockfile
mkdir -p data/workspaces/myProject
bun run build:server
```

`build:server` 会依次构建全部内置节点、工具、扩展、Web 前端和 Server，不是仅构建后端。只有该命令成功结束后才能继续。

`data/` 用于保存设置、插件和工作区，已被 Git 忽略。不要将其中的配置、API Key 或项目文件提交到仓库。

## 4. 启动项目

在仓库根目录执行：

```sh
NODE_ENV=production TOONFLOW_SERVER_PORT=3000 bun run start:server
```

保持该终端会话运行。看到下面的日志表示监听成功：

```text
[服务启动成功]: http://localhost:3000
```

如果 Agent 使用后台进程启动，必须记录 PID 和日志位置，并确认进程没有立即退出。例如：

```sh
mkdir -p data/logs
nohup env NODE_ENV=production TOONFLOW_SERVER_PORT=3000 bun run start:server > data/logs/server.log 2>&1 &
echo $!
```

后台方式只适用于 macOS / Linux shell。不要使用关闭终端后随之失效的临时进程来冒充安装完成。

## 5. 验证并打开应用

在另一个终端执行：

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/api/providers/media/list
```

返回的 JSON 应包含 `"code":200`。随后打开：

```text
http://127.0.0.1:3000
```

Agent 应在浏览器可操作时进一步确认页面标题为 `Toonflow`，且不是连接失败或空白错误页。只有构建成功但接口或页面未验证时，应明确报告“构建完成，启动验证未完成”。

模型服务需要在应用内单独配置：

- 文本模型：设置 → 语言模型
- 图片、视频和音频模型：设置 → 媒体模型
- 阿里云百炼：安装或编辑“阿里云百炼”，填写用户自己的 API Key 后保存

没有配置模型 Key 不影响项目启动，但不能据此声称已经验证真实媒体生成。

## 6. 停止、重启与更新

前台运行时按 `Ctrl+C` 停止。后台运行时只终止安装时记录的明确 PID。

重新启动：

```sh
cd video-flow
NODE_ENV=production TOONFLOW_SERVER_PORT=3000 bun run start:server
```

手动更新：

```sh
cd video-flow
git status --short
git pull --ff-only origin master
bun install --frozen-lockfile
bun run build:server
```

更新后重启服务。`git status --short` 非空时先询问用户，不要覆盖本地修改。更新与重启不会要求清空 `data/`，不要执行会删除数据卷的命令。

## 7. 常见问题

### `bun: command not found`

```sh
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version
```

仍失败时重新检查 Bun 安装输出，不要改用未经仓库验证的 Node 命令替代。

### 3000 端口已占用

macOS / Linux 可查看监听进程：

```sh
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

不要直接杀死不认识的进程。确认需要换端口时：

```sh
NODE_ENV=production TOONFLOW_SERVER_PORT=3001 bun run start:server
```

此时访问地址和验证 URL 都应改为 `3001`。

### 找不到 `build/server/index.js` 或节点没有加载

确认当前位于仓库根目录，重新执行：

```sh
bun install --frozen-lockfile
bun run build:server
```

不要只启动一个 Vite 预览页面代替完整服务；应用依赖 Server、API 和内置节点。

### 远程服务器无法访问

优先在用户自己的电脑上建立 SSH 隧道：

```sh
ssh -N -L 3000:127.0.0.1:3000 用户名@服务器地址
```

然后在本机访问 `http://127.0.0.1:3000`。不要因为远程访问失败就直接向所有公网地址开放端口。

## 可选：使用 Docker 启动

已安装并启动 Docker 时，可用 Docker 代替 Bun 源码构建：

```sh
git clone https://github.com/zivgogogo/video-flow.git
cd video-flow
docker compose up -d --build
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/providers/media/list
```

访问 `http://127.0.0.1:3000`。配置与项目保存在 Docker 命名卷 `toonflowData` 中；停止或重建容器会保留数据，**禁止执行 `docker compose down -v`**，因为 `-v` 会删除数据卷。

## 完成判定

只有以下条件全部满足，Agent 才能报告“安装并启动完成”：

- [ ] 仓库来自 `https://github.com/zivgogogo/video-flow.git`
- [ ] `bun install --frozen-lockfile` 成功
- [ ] `bun run build:server` 成功，或 Docker 镜像构建成功
- [ ] 服务进程仍在运行
- [ ] `/api/providers/media/list` 返回 HTTP 200 且响应包含 `"code":200`
- [ ] 浏览器能够打开 `http://127.0.0.1:3000`
- [ ] 已向用户报告访问地址和进程信息，且未泄露任何 API Key
