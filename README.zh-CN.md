# pi-board

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wait4xx/pi-board/actions/workflows/ci.yml/badge.svg)](https://github.com/wait4xx/pi-board/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20tested-lightgrey.svg)
![Ecosystem](https://img.shields.io/badge/ecosystem-pi--mesh-8A2BE2.svg)

**pi-mesh 房间的共享上下文板——类型化条目、有界诚实存储、布尔全文检索。
mesh 只做路由，永远不是数据库。**

## 概述

pi-mesh 房间已有消息（`mesh_send`）与工作区（git + `mesh_reserve`），
pi-board 是缺失的第三支柱：持久、可检索的**共享上下文**。五种类型化条目：

| 类型 | 含义 |
|---|---|
| `OBSERVED` | 所见——不作承诺 |
| `FACT` | 已验证的事实 |
| `FAIL` | 被证伪的路径——可检索，让全网不再重烧预算 |
| `CLAIM` | 信息性所有权标注，与 `mesh_claim` 租约配对（板不做强制） |
| `PATCH_SUMMARY` | 已落地变更做了什么 |

板维护有界的 append-only 本地存储并回答布尔检索；它以普通 peer 身份接入
mesh（成员或只读 observer），写入以普通优先级广播帧播报。
**任何存储都不进 broker。**

设计契约：[DESIGN.md](DESIGN.md) · 交付对账：
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) · 贡献指南：
[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## pi-mesh 技术栈

pi-board 是一组协同工具栈中的一层：

```
 pi-mesh 技术栈
 ┌───────────────────────────────────────────────────────────────┐
 │ pi-mesh    消息 · 路由 · 房间 · policy · 租约                  │
 │            github.com/cgarrot/pi-mesh                         │
 ├───────────────────────────────────────────────────────────────┤
 │ pi-board   共享上下文——本包                                   │
 ├───────────────────────────────────────────────────────────────┤
 │ pi-jobd    后台执行 + 孤儿收养                                 │
 │            github.com/cgarrot/pi-jobd （新生：v0.1.0）        │
 └───────────────────────────────────────────────────────────────┘
 pi-subagents——构建在 mesh 之上的 worker 控制（配套工具）
```

- **[pi-mesh](https://github.com/cgarrot/pi-mesh)**——基座：消息、路由、
  房间、policy、能力路由与任务租约。
- **pi-board**（本仓库）——房间的共享上下文：类型化条目、诚实有界存储、
  布尔检索。无任何 broker 侧存储。
- **[pi-jobd](https://github.com/cgarrot/pi-jobd)**——分离式后台作业，
  诚实状态与 daemon 重启后的孤儿收养（新生项目 v0.1.0；早期阶段，
  Windows 仍属实验性）。
- **pi-subagents**——构建在 mesh 之上的 worker 控制（派生、转向、跟进、
  中止）。

它们彼此组合：**发现落在板上**，**对话走 mesh**，**长活交给 jobd**，
**独占用 `mesh_claim` 租约**并由 **CLAIM 条目**标注关联。例如：

```text
mesh_send  → "谁看过 TLS 失败这个问题？"                     （对话）
board_grep → "tls"  → FAIL b17: 握手证书不匹配               （共享记忆）
mesh_run   → 后台重建（pijob 式长活）                        （长活）
mesh_claim → { task: "rebuild", paths: ["dist/"] }          （独占）
board_write→ CLAIM "重建归我" --lease-ref <leaseId>          （关联）
```

设计谱系上溯至 pi-mesh issue #13 的 Agensh/DeLM 讨论线——完整设计
故事在那里与 [DESIGN.md](DESIGN.md) 中；本节只画出邻里地图。

## 安装

从源码安装（尚未发布到 npm——未上架前不上死徽标）：

```bash
git clone https://github.com/wait4xx/pi-board.git
cd pi-board
npm ci            # 或：npm install
npm run build
```

两种使用模式：

- **纯 CLI**——零 peer 依赖即可工作；除 `join` 外的所有命令都只打本地
  存储（`--room` 完全不需要 mesh）。
- **配合 mesh**——在旁边安装 `pi-mesh-extension`（任何带 client core 的
  版本；已验证面覆盖 0.7.2–0.10.2）。板绝不 vendor 也不 fork 它；没有
  broker 侧组件。

要求：Node ≥ 20、零运行时依赖；Linux 为已实测平台。

## CLI 参考

```
piboard join <room> [--observer] [--alias A]
piboard write --type T --text "…" [--detail-file -|PATH] [--ref R] [--lease-ref L]
piboard read [--id ID] [--limit N] [--room ROOM]
piboard grep "a,b&c" [--type T] [--limit N] [--room ROOM]
piboard watch
piboard help [cmd]
```

| 命令 | 作用 |
|---|---|
| `join` | 成为该房间的板**在场面**：唯一的播报者。watermark 续播循环广播比持久化游标新的条目——含在场程宕机期间写入的条目（不静默丢失，也不重播）。 |
| `write` | 追加一条类型化条目。要求已 join 的角色——写闸的前提是配置身份。`--detail-file -` 有界读 stdin（交互终端直接拒绝而非挂死）。 |
| `read` | 最新窗口；或 `--id` 展开单条的 `detail`（detail 到达读者的唯一出口）。`--room` / `$PI_BOARD_ROOM` 支持完全无 join 的 store-only 读。 |
| `grep` | 对 `text` 与 `detail` 的布尔检索，覆盖全 TTL 可见跨度（含已轮转段）。无结果 = exit 0 + 空输出。 |
| `watch` | 新 FAIL 落地时打印轮边界 `⚠ board: N new FAIL — …` 行（仅限已 join 房间——边界摘要是在场行为）。 |

退出码：`0` 成功（含 grep 无结果）· `1` 错误 · `2` 用法 ·
`3` 未找到（`read --id` 无此条）· `4` 拒绝（observer / 非成员写）。

示例：

```bash
piboard join mesh --observer
piboard write --type FAIL --text "端口探测 13389 挂起" --detail-file -
piboard read --id b7
piboard grep "timeout,firewall&tls" --type FAIL --limit 5
PI_BOARD_STATE_DIR=/tmp/demo piboard read --room mesh     # store-only，无需 join
```

环境变量：`PI_BOARD_STATE_DIR`（状态根，默认 `~/.pi-board`）、
`PI_BOARD_ALIAS`（peer 别名，默认 `board`）、`PI_BOARD_ROOM`（读命令的
房间回退）、`PI_BOARD_OBSERVER=true`（强制 observer——仅限 fail-safe
方向），以及每个上限一个 `PI_BOARD_<LIMIT>` 覆盖（如
`PI_BOARD_ENTRY_TTL_MS`；坏值是点名变量的启动错误）。

## 扩展工具（v0.2）

作为 Pi 扩展加载后，板提供四个单动作工具：

| 工具 | 动作 |
|---|---|
| `board_write` | 追加类型化条目（与 CLI 相同的校验与闸） |
| `board_read` | 窗口读，或 `{ id }` 展开 detail |
| `board_grep` | 带过滤器 `type` / `limit` 的布尔检索 |
| `board_watch` | 快览房间记录过的失败 |

扩展**默认以 observer 自动加入**——在 `piboard join` 写入显式成员配置前
只读。`$PI_BOARD_OBSERVER=true` 可在成员配置之上强制 observer（仅限
fail-safe 方向，绝不反向）。无 broker 的机器上不拉起 broker（连接窗口内
置 `MESH_NO_AUTO_BROKER`）；死 peer 自动恢复；播报带房间标。

## 一页设计

**存储（append-only，构造即诚实）。** JSONL 分段按双上限（条数/字节）
轮转；已轮转段不可变且保持可检索。全局上限**拒写、绝不驱逐**——被引用
的 id 不许凭空消失。TTL 是可见性边界（查询期过滤；物理清理只发生在整段
过期后的轮转时；撕裂尾行只跳过，绝不构成写路径故障）。密钥形态在扫描处
fail-closed；字节上限按最终落盘行度量；跨进程 append 以 O_EXCL 锁串行，
id 恒唯一。

**检索。** `,` = OR、`&` = AND（AND 结合更紧），对 `text` 与 `detail`
大小写不敏感的子串匹配：

| 查询 | 匹配 |
|---|---|
| `foo` | text 或 detail 含 foo（不区分大小写） |
| `foo,bar` | foo OR bar |
| `foo&bar` | foo AND bar |
| `foo,bar&baz` | foo OR (bar AND baz) |

每行必含条目 id；仅 detail 命中的行带 `(in detail)` 标记——
`read --id` 是自然后手。

**闸与安全模型。** 同用户信任边界（0600 端点、0600 记录）。写路径先查
成员资格再查 observer 角色，镜像 pi-mesh `routeMsg` 的顺序，且按**配置**
身份裁决——绝不按 broker 状态——重连角色漂移打不开写路径。mesh 上永远
没有 shell 字符串：播报帧是闭合形状（类型 + id + 短文本），仅普通优先级。

**播报架构。** 一个在场程（`piboard join`）持有 peer 连接且是唯一播报者
——watermark 续播循环同样覆盖宕机期间写入的条目。一次性写永不连网（无
别名撞车）；`watch` 呈现轮边界 FAIL 摘要。FAIL 刻意取**普通**优先级：
边界摘要行胜过 urgent 帧。

## CLAIM 与 mesh_claim

`CLAIM` 条目（可选 `--lease-ref`）是**信息层**；`mesh_claim` 是**强制层**。
板记录谁在何时认领了什么、并关联租约 id——但绝不阻断、不设闸、不让任何
东西过期。

## 规模预期

查询扫描全 TTL 可见跨度（受上限约束：≤ 5 万条 / 32 MiB），无索引——本地
单房板的刻意取舍。存活条目过数万后，grep 延迟线性劣化。索引与多机检索
属后续议题。

## 收官实测

于提交 `dad72c4`（Linux / Node 22），干净克隆可复跑：

| 声称 | 证据 |
|---|---|
| 严格构建零错误 | `npm run build --silent` → exit 0 |
| 75 测试 / 0 失败 / 0 跳过 | `npm test` → `# tests 75 / pass 75 / fail 0 / skipped 0` |
| 真 broker 11 步 smoke | `npm run smoke` → `smoke: 11/11 ok, 0 skipped`（join → write → 广播 → read → grep → observer 拒写 → 仅一帧 → auto-join observer → 成员升级 → …） |

以上每个数字都是在所引树上落笔前亲手跑出的；
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) 保有完整链路。

## 路线图

今日刻意不做：broker 内存储（永久红线）、多房间索引、条目级 ACL、
urgent FAIL 投递、图形界面。

v0.3+ 候选，按价值粗排：多机检索（跨板 grep 联邦）、大跨度索引、
urgent-FAIL 问题（真有房间需要它压过边界行吗？）、CLI 与扩展共享的
watch 游标。此处无一承诺；范围变更走 spec 流程。

## 常见问答

**为什么 auto-join 默认是 observer？**
因为只读的错误可恢复，而写路径的错误不可恢复。静默加入的扩展应当能立即
**读**到房间上下文，但绝不该用写入惊扰房间。成员权力需要 `piboard join`
这个显式、人可见的动作。

**为什么由守护进程播报，而不是每次写自己连网？**
两个原因：别名撞车（一次性写顶着在场程的别名连接会打架），以及完整性
——在场程的 watermark 循环会播报它值守期间**任何进程**写入的条目，包括
它宕机期间落库的那些。按写连网只可能覆盖 CLI 自己的写。

**为什么上限拒写而不是驱逐旧条目？**
因为驱逐会让被引用的 id 凭空消失：对话里引用的板条目（`read --id b42`）
不该因为上限轮转而 404。拒写响亮、诚实，且由操作员裁决（放宽上限，或
归档一个段——段就是纯 JSONL）。

**CLI 报 `board config unreadable … fix or remove it` 是怎么回事？**
`board.json`（由 `piboard join` 写入）存在但不是合法 JSON 或缺字段——常见
于崩溃后的半写文件。修文件或删掉重 join；CLI 会报出确切路径与问题，
而不是用"未 join"误导你。

## 许可证

MIT——见 [LICENSE](LICENSE)。
