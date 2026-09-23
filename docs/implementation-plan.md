# 本地大模型三国杀 AI 对战：实施计划

基于 `docs/architecture-analysis.md` 的审计，按以下阶段渐进交付。第一阶段仅支持单局；不实现批量 tournament、训练、Android、视觉或推理框架专用逻辑。

**规则兼容性边界：** 当前执行引擎是独立的 `wmzy/sanguosha`，其主公/反贼单将 1v1 与官方移动版“至尊 1v1”（每方 3 将、专属牌堆、技能平衡调整）不等价。运行和数据一律标注 `engine_id`、上游提交和模式；阶段验收只证明适配该仓库。未来官方客户端接入须新增独立 `GameAdapter`，并按具体官方版本/模式验证，不在本阶段自动化操作官方应用。

## 阶段 1：文档和工程基线

- **目的：** 锁定审计基线和安全约束，建立可复现的开发命令。
- **修改：** `docs/architecture-analysis.md`、本文、必要的 package scripts 和示例配置。
- **完成条件：** 架构、可复用模块、风险、接口边界和验收步骤清楚；本阶段不修改游戏规则。
- **验证：** 文档中的入口、工具、路由和配置与 pinned commit 源码一致。

## 阶段 2：房间和 headless 生命周期

- **目的：** 让两个相互独立的 MCP seat 可靠启动原生 1v1 并在 REST/SSE 中推进。
- **修改：** HeadlessGameClient 请求认证与响应检查；MCP 配置允许选择原生模式；房间/session seed 的传递；ready/start/action 状态等待和错误报告。
- **完成条件：** 一席建房，另一席加入并准备，房主开局；客户端可观察引擎拒绝和结束状态。
- **验证：** headless 与服务端测试覆盖认证头、准备失败、动作拒绝、1v1 开局和 seed 记录。

## 阶段 3：安全 observation、具体动作和模型 provider

- **目的：** 让模型只看到自己可见的信息，并且只能选择引擎适配层给出的动作。
- **接口：** `ObservationBuilder(playerId)` 生成 `PlayerObservation`；`LegalAction` 用 opaque `action_id` 指向 runner 内部保存的具体引擎消息；provider 只接收 observation 和动作摘要，返回 `{ "action_id": "..." }`。
- **引擎标识：** 日志固定记录 `engine_id: wmzy/sanguosha`、精确 Git 提交和原生游戏模式，禁止把模拟引擎对局误标为官方规则数据。
- **修改：** observation 字段白名单；可执行动作的具体化和支持范围；独立 `ModelProvider`/`OpenAICompatibleProvider`；按座位隔离的请求历史；结构化输出解析、两次重试和确定性合法 fallback。
- **完成条件：** 未知/过期 action ID 不会提交；不完整或 unsupported 动作不暴露给模型；fallback 始终从当前可执行动作集合选取。
- **验证：** 隐藏手牌 counterfactual 测试、动作 ID/目标/过期状态测试、模型无效 JSON 重试和 fallback 测试。

## 阶段 4：单局 runner、日志和用户说明

- **目的：** 以单命令启动服务、两个 MCP 进程和两个独立模型 endpoint，自动完成并归档一局。
- **修改：** `pnpm match -- --config config/match.example.yaml --games 1 --seed 42 --headless`；mock OpenAI-compatible 服务集成测试；`runs/<时间>_game001/` 下脱敏配置、逐决策 JSONL、JSON/Markdown summary；README 启动和排障步骤。
- **日志：** 分开记录 `player_observation` 与可选的研究用 `internal_state`；任何 `internal_state` 都不可进入 provider 输入；API key 不落盘。
- **完成条件：** `--games` 仅接受 1；双方各自 endpoint/model 可配置；mock 对局无人干预结束、胜负明确、逐步日志完整。
- **验证：** 两个 mock endpoint、两个 MCP 子进程完整对局；同 seed 的 mock 决策运行可复现；现有 test、typecheck、lint 通过。真实 Qwen endpoint 可用时再运行同一 CLI 验证，若不可用则标记未实测。

## 阶段 5：GitHub 交付

- **目的：** 将完成且通过 mock 闭环和项目检查的代码发布到用户 fork。
- **交付：** 基于审计提交建立 `feat/local-llm-selfplay` 分支，提交改动并推送到用户账号下 `wmzy/sanguosha` fork；不自动创建 PR、不改上游。使用现有 GitHub 凭据，密钥不进入提交。
- **完成条件：** 远端分支与本地提交一致；回报分支地址、测试结果及真实 endpoint 验收状态。
