#!/usr/bin/env node
// Stands in for `codex exec` in tests: reads the prompt on stdin, writes a canned map to the -o file and
// prints JSON lines like the real CLI. FAKE_CODEX_FAIL=1 makes it fail; FAKE_CODEX_ARGS=file records the arguments.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
if (process.env.FAKE_CODEX_ARGS) writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_FAIL) {
    process.stderr.write('model unavailable\n');
    process.exit(1);
  }
  const pages = (input.match(/=== 第 \d+ 页/g) || []).length;
  writeFileSync(out, `## 一句话
测试地图：这篇论文共 ${pages} 页，用 $\\mathbf{C}(u)$ 表示刀轴曲线。[p.1]

## 问题与贡献
- **研究动机**：采样检测会漏检。[p.2]

## 结构
- [p.1–3] **1 Introduction**：提出问题。

## 核心概念与符号
- $r=\\sin\\alpha$：奇异圆半径。[p.5]

## 方法要点
1. 投影到平面。[p.4]
2. 目标函数见式 (11)，示意见图 7、算法 1。[p.8]

3. 求交：
   $f(u)=\\|\\mathbf q(u)-\\mathbf o\\|^2-r^2$。[p.6]

$$E = \\int_0^1 J^2\\,\\mathrm{d}u$$

## 主要结果
| 指标 | 本文 |
|---|---:|
| 耗时 | 726 ms |

## 假设、局限与未来工作
- 以 A–C 机床说明。[p.4]
`);
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-1' })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
});
