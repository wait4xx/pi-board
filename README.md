# pi-board — shared context board for pi-mesh / pi-mesh 共享上下文板

**Status: v0.2 (CLI slice + native extension tools) — measured at commit
`8dffd59`, Linux, Node 22. /
状态：v0.2（CLI 切片 + 原生扩展工具）——提交 `8dffd59` 实测，Linux / Node 22。**

## Overview / 概述

A pi-mesh room has messages (`mesh_send`) and a workspace (git +
`mesh_reserve`) — pi-board adds the missing third pillar: a **shared
context board**. Five typed entry kinds — `OBSERVED` (something seen),
`FACT` (verified truth), `FAIL` (a falsified path — searchable so the
whole room stops re-burning budget on it), `CLAIM` (informational
ownership note, paired with `mesh_claim` leases — the board never
enforces), `PATCH_SUMMARY` (what a landed change did).

pi-mesh 房间有消息（`mesh_send`）与工作区（git + `mesh_reserve`）——
pi-board 补上缺失的第三支柱：**共享上下文板**。五种类型化条目：
`OBSERVED`（所见）、`FACT`（已验证事实）、`FAIL`（被证伪的路径——可检索，
让全网不再重烧预算）、`CLAIM`（信息性所有权标注，与 `mesh_claim` 租约配对
——板不做强制）、`PATCH_SUMMARY`（已落地变更做了什么）。

The board keeps a bounded append-only local store (JSONL segments with
rotation, entry/byte caps that refuse rather than evict, TTL visibility,
a fail-closed forbidden-key scan) and answers boolean full-text queries
(`,` = OR, `&` = AND, case-insensitive, full TTL-visible span). It joins
the mesh as a normal peer (member or read-only observer), announces
writes as normal-priority broadcast frames, and puts NO storage in the
broker — the mesh stays a router, never a database.

板维护有界的 append-only 本地存储（JSONL 分段轮转、条数/字节上限拒写不
驱逐、TTL 可见性、fail-closed 禁键扫描），并回答布尔全文检索（`,` = OR、
`&` = AND、大小写不敏感、覆盖全 TTL 可见跨度）。它以普通 peer 身份接入
mesh（成员或只读 observer），写入以普通优先级广播帧播报，**绝不在 broker
里存任何东西**——mesh 只做路由，永远不是数据库。

Design and maintainer constraints: [DESIGN.md](DESIGN.md) · delivery
reconciliation: [docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) ·
contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

设计与维护者约束：[DESIGN.md](DESIGN.md) · 交付对账：
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) · 贡献指南：
[CONTRIBUTING.md](CONTRIBUTING.md)。

## Install / 安装

```bash
npm install && npm run build   # Node ≥ 20; zero runtime dependencies
```

```bash
npm install && npm run build   # Node ≥ 20；零运行时依赖
```

## CLI usage / CLI 用法

```bash
piboard join <room> [--observer] [--alias A]   # the room's board presence
piboard write --type FAIL --text "…" [--detail-file -|PATH] [--ref R] [--lease-ref L]
piboard read [--id ID] [--limit N] [--room ROOM]
piboard grep "a,b&c" [--type T] [--limit N] [--room ROOM]
piboard watch                                     # new-FAIL boundary lines
```

`join` is the board's presence: the only announcer (a watermark-resumed
loop that also announces entries written while it was down). `read`/
`grep` accept a store-only `--room` (scripts need no join); `write`
deliberately requires a joined role — the write gate's premise is a
configured identity. Exit codes: `0` ok · `1` error · `2` usage ·
`3` not_found (`read --id`) · `4` refused (observer/non-member write).
A grep miss is exit 0 with empty output.

`join` 是板的在场面：唯一的播报者（watermark 续播循环，宕机期间的条目回
归后补播）。`read`/`grep` 支持 store-only 的 `--room`（脚本无需 join）；
`write` 刻意要求先 join——写闸的前提是配置身份。退出码：`0` 成功 ·
`1` 错误 · `2` 用法 · `3` 未找到（`read --id`）· `4` 拒绝（observer/非成员
写）。grep 无结果 = exit 0 + 空输出。

## Native extension tools (v0.2) / 原生扩展工具（v0.2）

Loaded as a Pi extension, the board exposes four single-action tools:
`board_write` / `board_read` (window, or `{ id }` to unfold detail) /
`board_grep` (with `type` and `limit`) / `board_watch`. The extension
**auto-joins as an observer by default** — read-only unless `piboard
join` wrote an explicit member config; `$PI_BOARD_OBSERVER=true` can
force observer even over a member config (the fail-safe direction
only). It never spawns a broker on machines without one
(`MESH_NO_AUTO_BROKER` during the connect window) and recovers a dead
peer automatically; announces are room-tagged.

作为 Pi 扩展加载后，板提供四个单动作工具：`board_write` / `board_read`
（窗口读，或 `{ id }` 展开 detail）/ `board_grep`（支持 `type` 与 `limit`）/
`board_watch`。扩展**默认以 observer 自动加入**——除非 `piboard join` 写入
了显式成员配置，否则只读；`$PI_BOARD_OBSERVER=true` 可在成员配置之上强
制 observer（仅限 fail-safe 方向）。无 broker 的机器上绝不自动拉起 broker
（连接窗口内置 `MESH_NO_AUTO_BROKER`）；死 peer 自动恢复；播报带房间标。

## Design in one page / 一页设计

- **Five maintainer constraints (upstream ruling, issue #13):** gates
  mirror pi-mesh `routeMsg` semantics (membership before role); one
  tool, one action; `board_read {id}` is the only detail unfold; CLAIM
  is informational (enforcement lives in `mesh_claim`); FAIL at normal
  priority with a turn-boundary summary line — no urgent frames.
- **Storage honesty:** caps refuse (never evict — a referenced id must
  not vanish); TTL is a visibility bound; torn tail lines never break
  the write path; secrets fail closed at the scan, byte bounds measure
  the final stored line; appends serialize across processes (O_EXCL).
- **Search:** `,` = OR, `&` = AND (AND binds tighter), case-insensitive
  over text AND detail, across rotated-but-alive segments; every row
  carries the id; a detail-only hit is marked `(in detail)`.

- **维护者五约束（上游裁决，issue #13）：** 闸镜像 pi-mesh `routeMsg` 语义
  （先成员后角色）；一工具一动作；`board_read {id}` 是 detail 唯一出口；
  CLAIM 纯信息性（强制在 `mesh_claim`）；FAIL 普通优先级 + 轮边界摘要行——
  绝不用 urgent 帧。
- **存储诚实：** 上限拒写不驱逐（被引用的 id 不许凭空消失）；TTL 是可见
  性边界；撕裂尾行不断写路径；密钥扫描 fail-closed；字节上限按最终落盘
  行度量；跨进程 append 以 O_EXCL 串行。
- **检索：** `,` = OR、`&` = AND（AND 结合更紧），大小写不敏感，覆盖 text
  与 detail、含已轮转但仍存活的段；每行必含 id；仅 detail 命中带
  `(in detail)` 标记。

## CLAIM ↔ mesh_claim / CLAIM 与 mesh_claim

A `CLAIM` entry (optionally `--lease-ref` / `leaseRef`) is the
**information layer**; `mesh_claim` is the **enforcement layer**. The
board records who claimed what and when, and correlates it with a lease
id — it never blocks, never gates, never expires anything.

`CLAIM` 条目（可选 `--lease-ref` / `leaseRef`）是**信息层**；`mesh_claim`
是**强制层**。板记录谁在何时认领了什么、并与租约 id 关联——但绝不阻断、
不设闸、不让任何东西过期。

## Scale expectations / 规模预期

Queries scan the TTL-visible span (bounded by the caps: ≤ 50 000
entries / 32 MiB), not indexed — deliberate for a local single-room
board; past tens of thousands of live entries, grep latency degrades
linearly. Indexes and multi-machine search are future territory.

查询扫描全 TTL 可见跨度（受上限约束：≤ 5 万条 / 32 MiB），无索引——本地
单房板的刻意取舍；存活条目过数万后 grep 延迟线性劣化。索引与多机检索
属后续议题。

## Measured at v0.2 closeout / v0.2 收官实测

At commit `8dffd59` (Linux, Node 22), re-runnable from a clean clone:

| Claim | Evidence |
|---|---|
| strict build, zero errors | `npm run build --silent` → exit 0 |
| 75 tests / 0 fail / 0 skipped | `npm test` → `# tests 75 / pass 75 / fail 0 / skipped 0` |
| 11-step smoke on a real broker | `npm run smoke` → `smoke: 11/11 ok, 0 skipped` (join → write → broadcast → read → grep → observer refused → exactly-one-frame → auto-join observer → member upgrade → …) |

于提交 `8dffd59`（Linux / Node 22），干净克隆可复跑：

| 声称 | 证据 |
|---|---|
| 严格构建零错误 | `npm run build --silent` → exit 0 |
| 75 测试 / 0 失败 / 0 跳过 | `npm test` → `# tests 75 / pass 75 / fail 0 / skipped 0` |
| 真 broker 11 步 smoke | `npm run smoke` → `smoke: 11/11 ok, 0 skipped`（join → write → 广播 → read → grep → observer 拒写 → 仅一帧 → auto-join observer → 成员升级 → …） |

## Out of scope / 明确不做

Broker-side storage (permanent red line), multi-room indexes, per-entry
ACLs, urgent FAIL delivery, GUIs, multi-machine distributed grep.

broker 内存储（永久红线）、多房间索引、条目级 ACL、urgent FAIL 投递、
图形界面、多机分布式 grep。

## License / 许可证

MIT — see [LICENSE](LICENSE).

MIT——见 [LICENSE](LICENSE)。
