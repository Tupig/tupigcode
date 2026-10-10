---
name: debugging
description: 排错闭环：稳定复现→最小假设→定向定位→最小修复→回归防复发
---

# 排错闭环 / Debugging Closed Loop

## 1. 复现优先 / 1. Reproduce First

- 没有稳定复现就不修——先造最小复现（脚本/测试用例）

  Do not fix without a stable reproduction — first build a minimal reproduction (script/test case)

- 记录：输入、环境（版本/OS/env）、期望 vs 实际、完整报错第一行

  Record: inputs, environment (version/OS/env), expected vs actual, the first line of the full error message

## 2. 假设驱动（一次一个） / 2. Hypothesis-Driven (one at a time)

- 猜错 → 排除该假设，换下一个；禁止「一次改三处看哪个有用」

  Wrong guess → rule out that hypothesis and move to the next one; forbidden: "change three places at once to see which one helps"

- 二分：能插桩就插桩（printf/debug 日志），能隔离就隔离（最小化输入）

  Binary search: instrument where instrumentation is possible (printf/debug logs), isolate where isolation is possible (minimize the input)

## 3. 定位手法 / Localization Techniques

```bash
rg '报错关键词' src tests   # 报错文案反查源头
git log -S '可疑代码'        # 何时引入
git bisect                  # 回归窗口（见 git-log 技能）
```

- 测试挂 → 先看失败断言的期望/实际差值，差值指哪修哪

  A test fails → first look at the expected/actual delta of the failing assertion, and fix where the delta points

- 类型错 → `npx tsc --noEmit` 第一条错误通常是根因，后续是连锁

  Type error → the first error from `npx tsc --noEmit` is usually the root cause, the rest are knock-on effects

## 4. 最小修复 / Minimal Fix

- 只改导致根因的最小面；不顺手重构

  Change only the smallest surface that causes the root cause; do not refactor in passing

- 修完必须：原复现不再触发 + 全量回归绿

  After the fix it must be: the original reproduction no longer triggers + the full regression is green

## 5. 防复发 / Prevent Recurrence

- 加一条锁住该 bug 的测试（先写测试确认它对旧代码是红的）

  Add a test that locks down this bug (write the test first and confirm it is red against the old code)

- 若根因是流程漏洞 → 提 issue 记录，不只修个案

  If the root cause is a process gap → file an issue to record it, do not only fix the individual case
