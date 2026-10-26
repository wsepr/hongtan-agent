# 红探 Agent

红探（Hongtan）Agent 插件让 AI 通过 MCP 工具控制红探 Chrome 扩展：启动/停止抓取、查询任务状态、管理数据集并汇报进度。

## 安装

- CodeBuddy / WorkBuddy：从本仓库 marketplace 安装 `hongtan-agent`。
- Qoder：下载 Release 中的 `hongtan-agent-<version>.zip`，解压到 `~/.qoder-cn/plugins/local/`，得到 `hongtan-agent/` 目录。

> **手动安装注意**：zip 是薄分发包，**不包含 runtime 可执行文件**；解压后首次运行仍需访问对应版本的 GitHub Release 下载 runtime。无 Release、离线或 GitHub 不可达时，launcher 会明确报错，不会执行插件。

## 运行要求

- 首次运行需要网络：launcher 会从 GitHub Release 下载对应平台的受管运行时，并校验 SHA-256。
- 公开仓安装与手动 zip 安装共用同一下载链路；发布插件前必须先创建对应版本的 GitHub Release。
- 有 Node ≥ 22 时使用 Node launcher；无 Node 时使用 PowerShell/bash bootstrap。
- 开发/私有部署可设置 `HONGTAN_AGENT_RUNTIME` 指向本地可执行文件。
- 端口 17373 为 Broker/扩展共用；CodeBuddy 与 Qoder 共用同一个 Broker 单例。

## 许可证

自有代码为专有/EULA；部分文件裁剪自 MediaClaw-Agent，保留 Apache-2.0 许可，详见 `NOTICE` 与 `LICENSE`。
