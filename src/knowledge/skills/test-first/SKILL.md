---
name: test-first
description: 测试先行流程：红→绿→重构，三连回归与失败输出回喂的自验证纪律
---

# 测试先行 / Test First

## 红→绿→重构 / Red → Green → Refactor

1. **红**：按需求写测试（只测行为契约），跑一次确认失败，失败信息与预期一致
1. **Red**: write tests from the requirements (test only the behavior contract); run once to confirm failure, and the failure message must match expectations
2. **绿**：写最小实现让测试通过，不为未来过度设计
2. **Green**: write the minimal implementation that makes the tests pass; do not over-design for the future
3. **重构**：绿灯下改结构，测试是安全网
3. **Refactor**: change structure under a green light; tests are the safety net

## 本仓三连（每项完成必跑） / The Repo Triple (must run after each item is done)

```bash
npx tsc --noEmit      # 类型
npx vitest run        # 全量用例
npm run build         # 产物
```

Type check / full test suite / build artifacts.

## 自验证循环（RunTests 工具） / Self-Verification Loop (RunTests tool)

编辑/修复后调用 `RunTests`：失败输出已回喂 → 读输出定位 → 修复 → 复跑，
直到全绿。命令探测顺序：`TUPIG_TEST_CMD` → npm test（跳过占位）→ pytest → cargo → go。

After editing/fixing, call `RunTests`: the failure output is already fed back → read the output to locate → fix → re-run,
until everything is green. Command detection order: `TUPIG_TEST_CMD` → npm test (skip placeholders) → pytest → cargo → go.

## 断言纪律 / Assertion Discipline

- 测行为不测实现（不锁私有函数/调用次数，除非那是契约）
- Test behavior, not implementation (do not lock in private functions/call counts unless that is the contract)
- 临时目录用 `mkdtemp`，afterEach 清理，测试间零共享状态
- Use `mkdtemp` for temp directories, clean up in afterEach, zero shared state between tests
- env 变量测试：beforeEach 设、afterEach 删
- env variable tests: set in beforeEach, delete in afterEach
- 不确定性（时序/随机）→ 注入种子或放宽为区间断言
- Nondeterminism (timing/randomness) → inject a seed or relax to range assertions

## 什么时候不写测试 / When Not to Write Tests

- 纯展示层字符串拼接（有 e2e 兜底即可）
- Pure presentation-layer string concatenation (fine as long as e2e covers it)
- 一次性迁移脚本（跑完即弃）——但仍要人工验证一遍
- One-off migration scripts (discarded after running) — but still verify them manually once
