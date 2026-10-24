# Contributing to pi-board

## Ground rules / 基本约定

- **Zero runtime dependencies.** Everything is plain Node (ESM,
  NodeNext, strict tsc); `pi-mesh-extension` is an optional peer only.
- **Layering:** `store/` never imports `mesh/` or the extension; the
  extension is a thin adapter. The CLI and the extension are two faces of
  the same entries/store core.
- **Honesty is the product:** refuse over guess, visible skips over
  silent greens, measured numbers over arithmetic. If a claim cannot be
  measured, it does not go in the docs.
- **零运行时依赖。** 全部为纯 Node（ESM、NodeNext、strict tsc）；
  `pi-mesh-extension` 仅为可选 peer。
- **分层：** `store/` 绝不 import `mesh/` 或扩展层；扩展是薄适配。
  CLI 与扩展是同一 entries/store 内核的两个面。
- **诚实即产品：** 宁拒勿猜、可见跳过优于伪装全绿、实测数字优先于
  算术推断。无法测量的表述不进文档。

## Commits / 提交规范

- Conventional format: `type(scope): imperative subject` — **English
  subject AND body** (repo convention; the docs are bilingual, the
  history is not).
- One commit, one intent; the body explains WHY first, then the key
  moves (`-` bullets). `feat`/`fix`/`perf` carry a `Verified:` line with
  real commands and real numbers — nothing that was not actually run.
- No agent names, no `.spec/` paths (the spec workspace stays local),
  no trailer footers referencing out-of-repo artifacts.
- 提交格式：`type(scope): 祈使句主题`——**主题与正文一律英文**
  （仓库惯例：文档双语，历史不双语）。
- 一个提交一个意图；正文先讲为什么，再列关键做法。`feat`/`fix`/`perf`
  必须带 `Verified:` 行，只写真实跑过的命令与真实数字。
- 不出现 agent 名字；`.spec/` 不入库（工作流留在本地）；不引用
  仓库外产物的 footer。

## Tests / 测试要求

- `npm test` green before every commit; a behavior change lands WITH a
  test that can fail (assert the invariant, not the implementation).
- Real processes and a real broker for anything touching mesh/CLI —
  hermetic tmp dirs, scrubbed env, no shared state.
- Platform-conditional tests skip **visibly with a reason** — never a
  silent early-return that counts as a pass.
- 每次提交前 `npm test` 全绿；行为变更必须连同"能失败的测试"一起落
  （断言不变量，而非实现细节）。
- 凡涉及 mesh/CLI 的一律真进程 + 真 broker——hermetic 临时目录、净化
  环境、零共享状态。
- 平台条件测试以**可见 skip + 原因**呈现——禁止算作通过的隐形早退。

## Measured numbers / 数字对账

- Every number that appears in README/announcements traces to a
  re-runnable command, its key output, and a commit hash — recorded in
  [docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md).
- Never publish a number you did not run at the tree being described
  (the "no arithmetic" rule: 55+9 is not 64 until both were measured).
- README/对外文案里的每个数字都必须对应可复跑命令 + 关键输出 + 提交
  哈希——记录于 [docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md)。
  没在目标树上亲手跑过的数字一律不写（"禁止算术"规则）。

## Docs / 文档规则

- README and CONTRIBUTING are **bilingual, section-paired**: the English
  section first, the Chinese section immediately after, headings in
  pairs (`## Install` / `## 安装`). New sections follow the same shape.
- README 与 CONTRIBUTING 为**中英双语逐节对照**：英文节在前、中文节
  紧随、标题成对（如 `## Install` / `## 安装`）。新增节沿用同一形态。

## Design changes / 设计变更

- `DESIGN.md` is the contract; deviations land as explicit erratum
  notes in the affected section (see §3.2/§6 for the pattern), never as
  silent drift. Scope changes go through the spec package — an
  out-of-scope feature is a new package, not a quiet addition.
- `DESIGN.md` 是契约；偏离必须以"勘误注记"落在受影响节内（见 §3.2/§6
  的先例），禁止静默漂移。范围变更走 spec 包流程——越界功能是新包，
  不是悄悄加料。
