/**
 * 启用官方 HMR（改插件代码免重启），并把番茄钟包目录加进 watch roots。
 *
 *   node tools/enable-hmr.mjs [--dry] [--off]
 *
 * 背景：
 *  - `@deepseek-ai/dsh-hmr` 随基础 bundle 装好，但那一行默认 disabled，
 *    且属于 base bundle（plugin_manager 报 management-required，不允许直接改）；
 *    profile patch 是**更后一层**，可以按 id 覆盖 bundle 层声明——这是官方留的口子。
 *  - patch 对 hmr 是**整体替换 config**，所以 root 必须写全（不写就变成空 root，
 *    只监视配置文件，不监视插件目录）。
 *  - 同一个 patch 层里出现两个 `- id: hmr` 是隐患（同层重复 id），本脚本会先合并再写。
 *
 * 撤销：`node tools/enable-hmr.mjs --off`（恢复 disabled: true，不留 config）。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const DRY = process.argv.includes('--dry')
const OFF = process.argv.includes('--off')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const FILE = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')
/** 本包所在目录：由脚本自身位置推导，不写死路径（开源版必须如此）。 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\\\/g, '/')

const HEADER = [
  '# 官方 dsh-hmr（基础包自带，非第三方）：把番茄钟包目录加进模块 watch roots，',
  '# 改 host 代码免重启热重载。patch 对 hmr 是整体替换 config，root 需写全。',
  '# 撤销：node tools/enable-hmr.mjs --off（或删掉本块，恢复 base 默认）。',
].join('\n')

if (!existsSync(FILE)) {
  console.log(JSON.stringify({ error: 'profile patch 不存在', file: FILE }, null, 2))
  process.exit(1)
}

const original = readFileSync(FILE, 'utf8')
const lines = original.split('\n')

/** 摘掉所有既有 hmr 块（含紧邻其上的 hmr 注释行），避免同层重复 id。 */
const kept = []
let removed = 0
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  if (/^- id: hmr\s*$/.test(line)) {
    removed += 1
    i += 1
    while (i < lines.length && /^[ \t]+\S/.test(lines[i])) i += 1 // 跳过该块的缩进行
    i -= 1
    // 顺手删掉紧贴在上面的 hmr 注释
    while (kept.length > 0 && /^#.*hmr/i.test(kept[kept.length - 1])) kept.pop()
    continue
  }
  kept.push(line)
}

let text = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
if (!OFF) {
  text += '\n' + HEADER + '\n- id: hmr\n  disabled: false\n  config:\n    root:\n      - ' + PLUGIN_DIR + '\n'
}

if (DRY) {
  console.log(JSON.stringify({ dry: true, file: FILE, removedBlocks: removed, willSet: OFF ? 'disabled:true' : 'enabled + watch root' }, null, 2))
  process.exit(0)
}

copyFileSync(FILE, FILE + '.bak-hmr-' + new Date().toISOString().replace(/[:.]/g, '-'))
writeFileSync(FILE, text, 'utf8')
console.log(JSON.stringify({
  file: FILE,
  removedBlocks: removed,
  applied: OFF ? 'hmr disabled' : 'hmr enabled（watch root: ' + PLUGIN_DIR + '）',
  tail: readFileSync(FILE, 'utf8').split('\n').slice(-9).join('\n'),
}, null, 2))
