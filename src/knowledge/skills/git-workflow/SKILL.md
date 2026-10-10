---
name: git-workflow
description: issue-first 提交闭环：建 issue、测试先行、commit 关联 fix #N、CI 绿后关闭
---

# Git 工作流：issue-first 闭环 / Git Workflow: issue-first Closed Loop

## 核心循环（本仓纪律） / Core Loop (this repo's discipline)

1. **先建 issue**：无 issue 不动代码。`gh issue create --title "..." --body "..."`

   **Create the issue first**: no issue, no code changes. `gh issue create --title "..." --body "..."`

   - body 写：现象 / 影响面 / 方案 / 测试先行条目

     body: phenomenon / impact scope / plan / test-first item

2. **测试先行**：先写红测试，再实现转绿

   **Test first**: write the red test first, then implement to turn it green

3. **三连回归**：`npx tsc --noEmit` → `npx vitest run` → `npm run build`

   **Triple regression**: `npx tsc --noEmit` → `npx vitest run` → `npm run build`

4. **提交关联**：`git commit -m "... fix #N"`（commit message 自动关闭 issue）

   **Link the commit**: `git commit -m "... fix #N"` (the commit message auto-closes the issue)

5. **盯 CI**：

   ```bash
   RUN=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$RUN" --exit-status
   gh run list --limit 1 --json conclusion --jq '.[0].conclusion'
   ```

   **Watch the CI**:

6. **CI 绿后 close issue**（若 `fix #N` 已自动关，跳过）

   **Close the issue once CI is green** (if `fix #N` already auto-closed it, skip)

## 提交纪律 / Commit Discipline

- 一次提交只做一件事；标题祈使句 + 正文列改动点

  One commit does one thing only; imperative title + body listing the change points

- 分支：`fix/123-desc` 或 `feat/123-desc`，PR 标题带 issue 号

  Branches: `fix/123-desc` or `feat/123-desc`, PR title carries the issue number

- 不提交：密钥、`node_modules`、运行时产物（`.tupigcode/` 已 ignore）

  Never commit: secrets, `node_modules`, runtime artifacts (`.tupigcode/` is already ignored)

- 禁止：force push、改历史、跳过 CI 的操作

  Forbidden: force push, rewriting history, operations that skip CI

## 回滚决策 / Rollback Decisions

- 单文件误改 → `/rewind code <id>` 或 `git checkout -- <file>`

  A single file wrongly changed → `/rewind code <id>` or `git checkout -- <file>`

- 一轮全错 → `/rewind all`（三档：chat/code/all）

  An entire round wrong → `/rewind all` (three levels: chat/code/all)

- 已提交的错误 → `git revert <sha>`（不改历史）

  An already-committed mistake → `git revert <sha>` (history is not rewritten)
