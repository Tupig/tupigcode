---
name: docs-sync
description: 文档随代码同步：README 唯一文档、改动即更新、过时即 bug
---

# 文档同步纪律 / Documentation Sync Discipline

## 单文档原则 / Single-Document Principle

- 根 `README.md` 是**唯一**用户文档；不新增散落的 .md（docs/ 历史调研除外）

  The root `README.md` is the **only** user document; do not add scattered .md files (except historical research under docs/)

- 结构性新模块 → README 结构树补一行

  A structural new module → add a line to the README structure tree

- 新命令/新 env → README 命令表/环境变量段补一条

  A new command / new env → add an entry to the README command table / environment variables section

## 什么时候必须更新 README / When the README Must Be Updated

| 改动 | 要同步的位置 |
|------|------|
| 新 CLI 命令/子命令 | 快速开始 / 命令段 |
| 新 `TUPIG_*` 变量 | 环境变量段 |
| 新工具 | 内核特性 / 工具段 |
| 测试数变化 | 徽章与测试清单 |
| 目录结构变化 | 结构树 |

English summary: for each change, the README location that must be kept in sync — new CLI command/subcommand → Quick Start / commands section; new `TUPIG_*` variable → environment variables section; new tool → kernel features / tools section; test count change → badge and test list; directory structure change → structure tree.

## 写法 / Writing Style

- 中文、短句、示例优先；不写营销话术

  Chinese, short sentences, examples first; no marketing language

- 过时的描述 = bug，随修复一起改（不留「以后再说」）

  A stale description = a bug; fix it along with the fix (no "later")

- 改完自查：README 里的命令真的能跑吗（快速开始走一遍）

  Self-check after changing: do the commands in the README really run (walk through Quick Start once)

## 注释 / Comments

- 不写「这行在干什么」的废话注释；只写**为什么**（约束、坑、出处 issue）

  No filler comments saying "what this line does"; write only **why** (constraints, pitfalls, originating issue)

- 无要求不加注释；代码即文档

  Add no comments unless required; the code is the documentation
