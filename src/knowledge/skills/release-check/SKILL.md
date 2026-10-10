---
name: release-check
description: 发布/合并前检查单：三连回归、安全审计、e2e、CI 绿、文档终检
---

# 发布检查单 / Release Checklist

## 合并到 main 前（顺序执行） / Before Merging to main (in order)

1. **三连**：`npx tsc --noEmit` && `npx vitest run` && `npm run build`
1. **The triple**: `npx tsc --noEmit` && `npx vitest run` && `npm run build`
2. **安全**：`npm audit`（0 high/critical；有则先修）
2. **Security**: `npm audit` (0 high/critical; fix any first)
3. **e2e 冒烟**：`bash scripts/e2e.sh`（全链路：启动→对话→工具→退出）
3. **e2e smoke**: `bash scripts/e2e.sh` (full chain: start → chat → tools → exit)
4. **lint/格式**：按仓库配置（无则跳过，不临时引入）
4. **lint/format**: follow the repo configuration (skip if none; do not introduce one ad hoc)
5. **文档终检**：README 徽章数、命令示例、env 列表与实现一致
5. **Final doc check**: README badge count, command examples, and env list must match the implementation
6. **CI 绿**：push 后 `gh run watch` 到 conclusion=success
6. **CI green**: after push, run `gh run watch` until conclusion=success
7. **issue 清账**：本轮所有 `fix #N` 对应 issue 已关闭
7. **Issue cleanup**: every `fix #N` from this round has its corresponding issue closed

## 发版（如有 tag 流程） / Releasing (if there is a tag process)

- 版本号语义：破坏性 env/命令变更 → major；新能力 → minor；修 bug → patch
- Version number semantics: breaking env/command changes → major; new capabilities → minor; bug fixes → patch
- tag 前再跑一遍三连；tag 信息写变更点（面向使用者）
- Re-run the triple before tagging; the tag message should describe the changes (written for users)

## 回滚预案 / Rollback Plan

- 发布后发现问题：优先 revert + 新 patch，不改已发历史
- Problems found after a release: prefer revert + a new patch; do not rewrite published history
- 破坏性变更必须在 README 标注迁移方式（旧变量名/旧路径 → 新的）
- Breaking changes must document the migration path in the README (old variable name/old path → new one)
