---
name: refactor-safe
description: 无行为重构：小步走、测试守护、重命名全传播、结构变换与语义修改分离
---

# 安全重构 / Safe Refactoring

## 铁律 / Iron Rules

1. **行为不变**：重构前后测试结果必须完全一致（先绿再动）
1. **Behavior unchanged**: test results must be identical before and after the refactor (get green first, then change)
2. **小步**：每步可独立提交、可独立回滚；不攒大 diff
2. **Small steps**: each step must be independently committable and independently revertible; never accumulate a big diff
3. **结构与语义分离**：不重构的同时修 bug/加功能——先重构绿，再做语义改动
3. **Separate structure from semantics**: never fix bugs or add features while refactoring — finish the refactor with green tests first, then make semantic changes

## 手法 / Techniques

- **重命名**：编辑器全局替换后必须全仓传播——
  ```bash
  rg -n '旧名' --hidden -g '!.git'   # 注意隐藏目录！
  ```
  类型名、env 变量、文件名、README 示例一次改净
- **Renaming**: after a global editor replace, you must propagate it across the whole repo —
- **Moving files**: mv + update imports + confirm with rg that zero residual references remain
- **Extracting functions**: first extract in place (make parameters explicit); only after green, consider relocating
- **Deleting code**: confirm there are no references (rg across the whole repo including tests/docs) before deleting

## 守护网 / Safety Net

- 重构区间：`npx vitest run` 每步都跑，不等最后
- During a refactor: run `npx vitest run` at every step, do not wait until the end
- 没有测试覆盖的路径 → 重构前先补 characterization 测试
- Paths without test coverage → write characterization tests before refactoring
- 危险面（权限/解析/状态机）→ 重构后跑 e2e 冒烟
- Dangerous surfaces (permissions/parsing/state machines) → run e2e smoke tests after the refactor

## 何时停下 / When to Stop

- 测试开始红且原因不明 → 回到上一个绿点，别硬改
- Tests start failing and the reason is unclear → go back to the last green point; do not force changes
- diff 超过 ~400 行还没绿 → 拆成两个 PR
- The diff exceeds ~400 lines and is still not green → split it into two PRs
