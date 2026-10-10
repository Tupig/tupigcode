---
name: code-review
description: 代码评审清单：正确性、边界、安全、并发、测试与文档六面一次过
---

# 代码评审清单 / Code Review Checklist

## 六个面（按序） / Six Aspects (in order)

1. **正确性**：逻辑是否符合 issue 描述？边界（空/0/负/首尾）覆盖了吗？

   **Correctness**: does the logic match the issue description? Are edge cases (empty/0/negative/first and last) covered?

2. **错误处理**：失败路径静默了吗（空 catch、吞异常）？错误信息可行动吗？

   **Error handling**: are failure paths silent (empty catch, swallowed exceptions)? Are error messages actionable?

3. **安全**：注入（SQL/shell/正则 ReDoS）、路径穿越、密钥入仓、SSRF、XSS

   **Security**: injection (SQL/shell/regex ReDoS), path traversal, secrets committed to the repo, SSRF, XSS

4. **并发/时序**：共享状态有竞态吗？重复触发（幂等）安全吗？

   **Concurrency/timing**: are there races on shared state? Is repeated triggering (idempotency) safe?

5. **测试**：断言的是行为不是实现？红→绿可复现？有没有只为过测试的假绿？

   **Tests**: do assertions cover behavior rather than implementation? Is red→green reproducible? Is there any fake green that only passes the test?

6. **文档**：README/注释随改动更新了吗？过时文档比没文档更糟

   **Docs**: were README/comments updated along with the change? Stale documentation is worse than no documentation

## 本仓特有 / Repo-Specific

- 新 env 变量：前缀 `TUPIG_`、README 有说明、默认值安全

  New env variables: prefix `TUPIG_`, documented in README, safe defaults

- 新工具：toolRegistry 注册 + e5 默认集断言同步

  New tools: toolRegistry registration + e5 default set assertion kept in sync

- 权限相关：deny→ask→allow 顺序、plan 模式行为

  Permission-related: deny→ask→allow order, plan mode behavior

- 隐藏文件：`.tupigcode/` 变更要想到 rg 默认不搜隐藏目录

  Hidden files: changes under `.tupigcode/` — remember that rg does not search hidden directories by default

## 输出格式 / Output Format

按「文件:行号 — 问题 — 建议」列条目；阻塞项（bug/安全）与建议项分级；
不确定的标注「疑问」并给出验证方法，不断言。

List entries as "file:line — issue — suggestion"; grade blocking items (bug/security) separately from advisory ones; mark uncertain items with 「疑问」 and give a verification method — do not assert.
