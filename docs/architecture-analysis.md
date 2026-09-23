# wmzy/sanguosha 架构审计

审计基线：上游提交 `dbe7744b08bea04a67a8e7241c51aa11c4c907fa`。本文仅描述该提交中的实现，不把后续版本行为当作既有能力。

## 现有结构

- 项目使用 TypeScript、Node.js（`>=22`）、Vite/React；Hono 提供 HTTP API。`pnpm server` 启动游戏服务，`pnpm mcp:serve` 启动 MCP stdio 客户端。
- 游戏状态由引擎和服务端 `GameSession` 管理。开局经过创建/加入房间、准备、房主开局、选将、发牌和回合阶段；动作通过服务端 session 的校验和 dispatch 推进。引擎使用 seed 初始化确定性随机数。
- headless 客户端 `HeadlessGameClient` 通过 REST 加入普通房间，通过 SSE 接收针对本座位的事件，并在本地维护 viewer 视图及 `availableActions`。
- MCP 服务器每个进程持有一个 headless 客户端和一个座位。工具包括 `createRoom`、`joinRoom`、`spectateRoom`、`play`、`getSnapshot`、`getSkillInfo`、`reportBug`。`play` 可阻塞等待决策点并提交引擎 `ClientMessage`。
- 引擎支持原生 `1v1` 规则包（双人、主公对反贼、并行选将、先死亡者负）；MCP `buildRoomConfig` 当前固定使用身份局。
- `availableActions` 已枚举不少当前座位动作，但其中部分消息是需要补目标/牌选择的模板，不能直接视作完整、可执行的 legal action。推荐动作是启发式建议，不是自动玩家。
- 服务端保存 action log、事件日志和对局历史/录像；这些是规则服务的内部持久化，不包含 LLM 请求、回复、token 和逐决策实验指标。

## 隐私与接口风险

- `buildView(state, viewer)` 对普通 viewer 仅填充自己的 `players[].hand`，其他玩家只返回手牌数；身份也按规则隐藏。`viewProjector.projectView` 会进一步省略 `cardMap`，说明现有 viewer 投影可作为安全边界的上游输入。
- 不能把原始 `GameView`、`pending.atom`、`cardMap`、服务端完整状态或原始 action log 发送给模型。`GameView.cardMap` 是全量牌映射；牌 ID/事件 payload 也不应被假定为安全。
- MCP 的 `play` 结果含 `pending`、`newLog`、`stateDiff`、`availableActions` 等字段；即使其事件由 viewer 过滤，也必须在模型适配层二次白名单投影。MCP 本身不是最终的模型 observation contract。
- 普通房间 REST 路由要求认证。headless 客户端的 create/join 使用 `authFetch`，但动作提交及 room operation 请求也需一致携带 token，并且 ready/start 必须等待 HTTP 结果，否则启动错误可能变成静默等待。
- REST action 返回 `accepted` 不能单独证明动作已由引擎接受；应继续等待 SSE 的拒绝/序号变化并在日志中保存最终结果。

## 可复用部分与建议适配

直接复用规则引擎、`GameSession`、原生 1v1、普通房间 REST/SSE、单座位 MCP 进程、headless `availableActions` 以及既有 action log/录像能力。只在需要处修正 MCP 房间配置、headless 请求认证和 ready/action 错误反馈。

新增独立 match runner，管理两个 MCP 子进程和两个互相隔离的模型会话；新增 `PlayerObservation` 白名单构建器及 `LegalAction` 适配层。LLM 只接触可见字段和已具体化的动作选项，并返回 action ID；原始 MCP 操作对象仅保存在 runner 内供 ID 映射和执行。

第一版应只启用已经覆盖端到端测试的动作类型。多步技能、分配、弃牌组合、选将候选等不能完整列举为具体动作时，要么补全动作枚举并验证，要么记为 unsupported，交给明确的合法 fallback；不能让模型任意构造引擎消息。

## Headless、并发与可复现性

- UI 不是对局驱动的必要条件：Node 服务、MCP stdio 客户端和 REST/SSE 可无 UI 运转。
- 两个 MCP 进程可以各持一个普通账号加入同一房间；同一 MCP 会话已有“一进程一座位”语义。编排器需先创建房间，再让另一进程加入，并并发监听双方的 `play` 决策等待。
- `GameSession` 使用 session seed 初始化引擎 RNG，默认 seed 为当前时间；当前 MCP REST 启动流程没有显式传入 match seed 的路径。需增加服务端配置入口，并将 seed 写入运行配置。相同 seed 只能复现游戏环境；模型若非确定性，完整动作轨迹仍以已记录动作重放为准。
- 现有回放/action log 不等于 LLM 实验日志。每局还需单独记录 observation、合法动作、模型请求/原始回复、选择结果、延迟、usage、重试/fallback 和胜负；配置中的密钥必须脱敏。

## 最大技术风险

最大风险不是模型 HTTP 调用，而是从上游 `availableActions` 到“完整且真实可执行的离散合法动作”的覆盖率，以及将过滤后的 MCP 观察、日志和决策结果正确关联到各自座位。先以原生 1v1 和端到端覆盖的基础动作闭环；对尚未覆盖的复杂窗口安全兜底并记录，不宣称支持所有技能。

## 与游卡官方游戏的规则差异（重要）

`wmzy/sanguosha` 是一个独立的 Web 游戏实现，不是游卡官方客户端、规则 SDK 或官方服务器接口。其 README 将内容描述为 165 名武将和标准版/军争牌；该数字和规则范围不能代表当前官方移动版。

官方移动版公开资料列出身份场（官方模式页为 8 人，应用介绍另列 5 人/8 人军争）、2V2 排位、国战等多种模式。官方“至尊 1v1”资料说明它是双方各有 3 名武将依次出战、专属 1v1 将池/牌堆且部分技能为平衡而调整的模式。仓库 `src/engine/rules/1v1.ts` 则描述双人主公对反贼、单名武将先死亡即负、双方各自进行普通选将；两者不是同一规则。

官方资料：[模式介绍](https://www.sanguosha.cn/pc/mode-info-1.html)、[至尊 1v1 指引](https://www.sanguosha.cn/pc/guide-info-37.html)、[官方功能介绍](https://www.sanguosha.cn/pc/news-detail-1618.html)。

因此本仓库第一阶段产物只验证**在 wmzy 模拟引擎上**的多 Agent 编排、隐私隔离、模型接口和日志质量。对局记录必须写明 `engine_id: wmzy/sanguosha`、引擎提交和 `game_mode`，不得被当作官方客户端数据或官方规则评测结果。将来接入官方 Android 客户端，需要独立的 `GameAdapter` 实现和针对目标版本/模式的规则差异测试；若不存在官方授权/稳定 API，还需另行确认允许使用的客户端集成方式。本阶段不操作官方客户端、不做 OCR/自动点击，也不逆向/调用官方服务协议。
