# BreachWeave 20 课时实战教程 - 索引

> 从零开始一步步搭出一个 CTF / 渗透测试多 Agent 协作平台。
> 每课都有详细的操作步骤 + 验证方法，跟着做一定能跑出来。

## 教程特点

- ✅ **初学者友好**：每个命令都有解释，每个文件都有完整代码
- ✅ **渐进式**：每课只加一点点新东西，不积压未理解的内容
- ✅ **可视化反馈**：每课末尾都有明确的验证步骤，能看到效果
- ✅ **故障排查**：列出常见错误和解决方法

## 课程地图

### 阶段 1：地基（课时 1-5）
搭出仓库结构 + 让一个 LLM agent 在本地跑起来。

- [x] [课时 1：初始化 Bun monorepo](./01-init-monorepo.md)
- [x] [课时 2：ConfigManager 骨架 + 目录布局](./02-config-manager.md)
- [x] [课时 3：API Key / Provider / Model 偏好 CRUD](./03-config-crud.md)
- [x] [课时 4：Prompt 文件格式 + 加载器](./04-prompt-loader.md)
- [x] [课时 5：第一个 AgentSession + CLI 跑通](./05-first-agent-session.md)

### 阶段 2：容器化（课时 6-10）
把 agent 跑进 Docker 容器 + 搭出 Web UI。

- [x] [课时 6：Docker 镜像 + Dockerfile](./06-docker-image.md)
- [x] [课时 7：RuntimeManager.launch —— 拉起容器](./07-launch-container.md)
- [x] [课时 8：Solver RPC 协议 + init 握手](./08-rpc-handshake.md)
- [x] [课时 9：Host Bridge —— solver 反查宿主](./09-host-bridge.md)
- [x] [课时 10：Web UI 雏形（Bun.serve + REST API）](./10-web-ui.md)

### 阶段 3：多 agent 编排（课时 11-15）
Planner LLM 自动调度 solver、challenge 数据存储、实时 SSE 推送。

- [x] [课时 11：Challenge 数据存储层](./11-challenge-store.md)
- [x] [课时 12：Challenge API 客户端 + Mock 模式](./12-challenge-api.md)
- [x] [课时 13：ChallengeManager 控制平面](./13-challenge-manager.md)
- [x] [课时 14：Planner LLM 调度循环](./14-planner-loop.md)
- [x] [课时 15：SSE 实时推送](./15-sse-push.md)

### 阶段 4：Observer 与状态（课时 16-20）
策略板维护 + 强制续跑 + 协作广播。

- [x] [课时 16：ideas + memory 存储](./16-memory-store.md)
- [x] [课时 17：Observer sidecar 工具集](./17-observer-tools.md)
- [x] [课时 18：Observer loop —— 触发 review](./18-observer-loop.md)
- [x] [课时 19：Ralph Loop（强制续跑）](./19-ralph-loop.md)
- [x] [课时 20：协作广播 + Attack Timeline](./20-collaboration.md)

### 阶段 5：工程化（课时 21）
代码长大了之后的重构。

- [x] [课时 21：CLI 模块化重构 —— 拆开 main.ts](./21-cli-refactor.md)

## 前置准备

开始第 1 课前，确认你已安装：

- **Bun >= 1.1**（运行时） - [安装指南](https://bun.sh/)
- **VS Code** 或其他编辑器（推荐装 TypeScript 扩展）
- **macOS / Linux**（Windows 推荐 WSL2）
- **Git**（版本控制）

阶段 2 之后还需要：
- **Docker Desktop**（跑 solver 容器）

## 节奏建议

| 节奏 | 每课投入 | 适合人群 |
|---|---|---|
| 快速 | 2-4 小时 | 熟悉 Bun + TS |
| 标准 | 4-6 小时 | 熟悉编程但没用过 Bun |
| 慢速 | 1-2 天 | 完全新手 |

## 怎么用这个教程

1. **按顺序做**：每课都依赖前面的成果，跳着做会卡。
2. **不要复制粘贴**：手敲一遍能记住，复制粘贴学不到东西。
3. **遇到错误先看"故障排查"**：常见错误都列出来了。
4. **做完一课再进下一课**：不要积累未验证的代码。

## 完成后的收获

- ✅ 一个能跑的多 Agent LLM 平台
- ✅ Bun + TypeScript + Docker 实战经验
- ✅ pi-coding-agent SDK 的深度使用
- ✅ Prompt 工程 + LLM-as-orchestrator 思维
- ✅ 文件锁 / SSE / 嵌套 RPC 等高级技术

准备好就从 [课时 1](./01-init-monorepo.md) 开始吧！
