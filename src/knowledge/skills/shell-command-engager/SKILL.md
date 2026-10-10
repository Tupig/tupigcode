---
name: shell-command-engager
description: 安全执行 shell：正确引用、超时意识、失败诊断，破坏性操作前必确认
---

# Shell 命令执行守则 / Shell Command Execution Rules

## 执行前 / Before Execution

- 破坏性命令（rm -rf、git push --force、drop、truncate、覆盖重定向到关键文件）**先确认再执行**
- Destructive commands (rm -rf, git push --force, drop, truncate, overwriting redirects to critical files): **confirm before executing**
- 长命令给 timeout；可能挂起的（交互式、watch、需要 TTY）不要直接跑
- Give long commands a timeout; never run things that may hang (interactive, watch, requires a TTY) directly
- 路径含空格/中文 → 双引号包裹每一个路径参数
- Paths containing spaces/Chinese characters → wrap every path argument in double quotes

## 引用坑 / Quoting Pitfalls

```bash
# 错：变量/通配被提前展开
rm $FILE
# 对：
rm "$FILE"

# 单引号内不展开（正则、反引号安全）
rg 'pattern' --glob '*.ts'
```

Wrong: variables/globs expanded early — `rm $FILE`. Right: `rm "$FILE"`.

Inside single quotes nothing is expanded (safe for regex and backticks).

## 失败诊断顺序 / Failure Diagnosis Order

1. 看 **exit code** 与 stderr 第一行（错误根因通常在最前）
1. Look at the **exit code** and the first line of stderr (the root cause is usually at the very front)
2. command not found → 装没装 / PATH / 是否该用 npx·npm run
2. command not found → is it installed / PATH / should you use npx·npm run instead
3. permission denied → 路径错误还是权限（别急着 chmod 777）
3. permission denied → wrong path or wrong permissions (do not rush to chmod 777)
4. EACCES/EPERM on macOS → 别碰 /System /Library /usr 等敏感路径（会被权限层 deny）
4. EACCES/EPERM on macOS → do not touch sensitive paths like /System /Library /usr (they will be denied by the permission layer)
5. 网络类（fetch failed/timeout）→ 先 curl 复现，再看代理/DNS
5. Network errors (fetch failed/timeout) → reproduce with curl first, then check proxy/DNS

## 输出处理 / Output Handling

- 大输出用 `| tail -30` / `rg` 过滤，不整段吞
- For large output, filter with `| tail -30` / `rg`; do not swallow the whole chunk
- 管道失败排查：`set -o pipefail` 或分步跑
- Pipeline failure debugging: `set -o pipefail` or run in steps
- 修改类命令（mutate）跑完给一句结果确认；远程发布类（push/publish/deploy）必须人工确认
- After a mutating command, give a one-line result confirmation; remote publishing commands (push/publish/deploy) must be manually confirmed
