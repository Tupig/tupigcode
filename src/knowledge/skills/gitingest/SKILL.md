---
name: gitingest
description: 快速吃透一个陌生仓库：结构优先、入口追起、测试锚定，避免全文通读
---

# 陌生仓库速读（gitingest 式） / Rapid Reading of an Unfamiliar Repo (gitingest style)

## 五步顺序（禁则：不要从头读） / Five-Step Order (Rule: do not read from the top)

1. **骨架**：`ls` 根目录 → README（架构/命令）→ package.json / pyproject（脚本与依赖）
1. **Skeleton**: `ls` the root → README (architecture/commands) → package.json / pyproject (scripts and dependencies)
2. **入口**：bin/main/index/CLI 定义处，顺一条最短调用链读下去
2. **Entry point**: wherever bin/main/index/CLI is defined; follow one shortest call chain downward
3. **测试当文档**：挑 2-3 个测试文件看断言——测试是行为的真契约
3. **Tests as documentation**: pick 2-3 test files and read their assertions — tests are the true contract of behavior
4. **目录地图**：`RepoMap` 工具或 `find src -name '*.ts' | head -50` 建立心智模型
4. **Directory map**: use the `RepoMap` tool or `find src -name '*.ts' | head -50` to build a mental model
5. **定向读**：带着问题 grep（`Grep`/`Glob` 工具），只读命中文件的命中段落
5. **Targeted reading**: grep with a question in mind (`Grep`/`Glob` tools); read only the matching sections of matching files

## 抓手 / Levers

- 配置即行为：env 变量、config schema、CI workflow 揭示真实约束
- Configuration is behavior: env variables, config schema, and CI workflows reveal the real constraints
- TODO/FIXME/`issue #N` 注释指向未完事项
- TODO/FIXME/`issue #N` comments point to unfinished items
- CHANGELOG/git log 看演进方向（配套 git-log 技能）
- Read CHANGELOG/git log for the direction of evolution (paired with the git-log skill)

## 输出物 / Deliverables

读完应能回答：入口在哪、核心数据流、怎么跑测试、改动应落在哪个目录。

After reading, you should be able to answer: where the entry point is, the core data flow, how to run tests, and which directory a change belongs in.

不能回答就继续定向读，不要开始猜。

If you cannot answer, keep reading in a targeted way — do not start guessing.
