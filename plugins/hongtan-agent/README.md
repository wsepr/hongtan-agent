# 红探 Agent

红探（Hongtan）Agent 插件让 AI 通过 MCP 工具控制红探 Chrome 扩展：启动/停止抓取、查询任务状态、管理数据集并汇报进度。

## 安装

- CodeBuddy / WorkBuddy：从本仓库 marketplace 安装 `hongtan-agent`。
- Qoder：下载 Release 中的 `hongtan-agent-<version>.zip`，解压到 `~/.qoder-cn/plugins/local/`，得到 `hongtan-agent/` 目录。

> zip 已包含 `runtime/hongtan-agent.mjs`，首次启动无需下载 runtime。

## 运行要求

- 需要 Node.js >= 22。Qoder 使用 `${QODER_NODE_RUNTIME}`；WorkBuddy 使用系统 Node 或 `HONGTAN_AGENT_NODE` 指定的 Node。
- Linux/macOS 若 `.sh` 无可执行位，请用 `sh scripts/launch-agent.sh` 启动。
- 首次启动不访问 GitHub Release，也不下载平台二进制。
- 端口 17373 为 Broker/扩展共用；CodeBuddy 与 Qoder 共用同一个 Broker 单例。

## 许可证

自有代码为专有/EULA，详见 `LICENSE`。本包不包含第三方运行时或引擎。
