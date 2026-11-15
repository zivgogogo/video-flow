# video-flow

开源 AI 短剧、漫剧与视频创作平台。

video-flow 是面向短剧、漫剧和短视频创作者的开源 AI 创作工具。通过无限画布编写剧本与分镜、管理角色和场景素材、生成图片与视频。支持本地部署、自由接入模型，并可通过 AI Agent、MCP 与插件扩展创作流程。

## 功能

| 能力 | 说明 |
| --- | --- |
| 🏠 **本地部署** | 项目与素材保存在自己的设备或服务器，支持桌面、Android、Docker 与服务器部署。 |
| 🖼️ **无限画布** | 在同一画布中组织剧本、角色、场景与视频片段。 |
| 🔌 **MCP** | 通过 MCP 连接外部工具与服务。 |
| 🧩 **插件** | 通过插件扩展节点、工具与创作能力。 |
| 🤖 **开放 Agent** | 开放提示词、工具和 A2A，支持自定义 Agent 行为及外部协作。 |
| 🔧 **自由接入模型** | 配置第三方 API，也可接入本地 ComfyUI 和 LLM。 |
| 🌐 **多语言界面** | 支持简体中文、繁體中文、English、日本語、한국어、Русский、العربية 等 21 种界面语言。 |

## 快速开始

### 使用 Agent 自动安装

将 [Agent 安装与启动指南](./docs/agentInstallation.md) 交给支持终端操作的 AI Agent。文档包含从 `git clone`、环境准备、完整构建到启动验证的命令，以及已有目录、端口占用和远程访问的处理规则。

### Docker

仓库提供 [Dockerfile](./Dockerfile)、[Compose 配置](./compose.yaml) 和 [构建排除规则](./.dockerignore)，镜像内包含 FFmpeg。

```sh
git clone https://github.com/zivgogogo/video-flow.git
cd video-flow
docker compose up -d --build
```

启动后访问 `http://127.0.0.1:3000`。首次启动会初始化内置插件，并提供 `myProject` 工作目录。

配置、插件和项目文件保存在 Docker 命名卷中，挂载至容器的 `/app/data/`。停止或重建容器会保留数据，**请勿执行 `docker compose down -v`，该命令会删除数据卷**。

```sh
docker compose logs -f   # 查看日志
docker compose stop      # 停止服务
docker compose start     # 再次启动
docker compose down      # 删除容器，保留数据卷
```

### 服务器

以 Ubuntu / Debian 为例，使用 [Bun 1.4.3](https://bun.sh/docs/installation)：

```sh
sudo apt-get update
sudo apt-get install -y git curl unzip ffmpeg
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.3"
export PATH="$HOME/.bun/bin:$PATH"

git clone https://github.com/zivgogogo/video-flow.git
cd video-flow
bun install --frozen-lockfile

# 构建内置节点、工具、Web 与 Server
bun run build:server
mkdir -p data/workspaces/myProject
bun run start:server
```

看到启动成功提示后，在服务器本机访问 `http://127.0.0.1:3000`。需要开机自启与进程托管时，可参考 [Bun 的 systemd 部署指南](https://bun.sh/guides/ecosystem/systemd)。

### 客户端

桌面端与 Android 安装包发布在 [Releases](https://github.com/zivgogogo/video-flow/releases) 页面。

## 使用与安全

- 服务默认使用固定端口 `3000`，业务页面与 API 没有独立登录鉴权。服务器安装时请通过防火墙或安全组限制端口访问来源，公网访问需配置带认证的反向代理。
- 个人远程使用可在本机执行 `ssh -N -L 3000:127.0.0.1:3000 用户名@服务器地址`，保持连接后打开 `http://127.0.0.1:3000`，无需将 `3000` 端口向公网开放。
- 配置、插件与工作区默认保存在仓库的 `data/`，Docker 安装则保存在数据卷内的 `/app/data/`。迁移或备份时请完整保留。
- 模型服务的 API Key 在页面内配置，不随仓库分发。

## 许可

本项目采用 [MIT 许可证](./LICENSE)。
