/**
 * lib/store.js 的回归测试——**独立 node 脚本，不依赖任何 DSH 插件**。
 *
 *   node tools/smoke.mjs
 *
 * 用可控时钟跑完整场景：轮次周期 / 暂停恢复 / 跳过 / 停止 / 离线结算 /
 * 持久化 / 统计（今日+本周）/ 背景音 / v1 状态迁移 / 坏输入。
 * 退出码 0 = 全过，1 = 有失败。
 */
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, STATE_VERSION } from '../lib/store.js'

const DIR = join(tmpdir(), 'pomodoro-ai-smoke')
const DIR_V1 = join(tmpdir(), 'pomodoro-ai-smoke-v1')

const checks = []
const check = (name, cond, extra) => checks.push({ name, pass: Boolean(cond), extra: cond ? undefined : extra })
const section = (title) => checks.push({ section: title })

rmSync(DIR, { recursive: true, force: true })
rmSync(DIR_V1, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
mkdirSync(DIR_V1, { recursive: true })

let clock = 1_700_000_000_000
const now = () => clock

// ═══ 基础：启动 / 暂停 / 恢复 / 完成 ═══════════════════════════════════════
section('基础计时')
const s = createStore({ dir: DIR, now })
let snap = s.snapshot()
check('初态 idle/idle', snap.phase === 'idle' && snap.runState === 'idle', snap.phase + '/' + snap.runState)
check('初态时长=25min', snap.remainingSec === 1500, snap.remainingSec)
check('初态轮次 1/4', snap.workRoundNumber === 1 && snap.roundsPerCycle === 4, snap.workRoundNumber)

let r = s.command('start', {}, 'ai')
snap = r.snapshot
check('start → work/running', snap.phase === 'work' && snap.runState === 'running', snap.phase + '/' + snap.runState)
check('deadline = now+1500s', snap.deadlineAt === clock + 1500000, snap.deadlineAt)

clock += 600000
check('走 10 分钟后 remaining=900', s.snapshot().remainingSec === 900, s.snapshot().remainingSec)

r = s.command('pause', {}, 'widget')
snap = r.snapshot
check('pause → paused & 冻结 900', snap.runState === 'paused' && snap.remainingSec === 900, snap.runState + '/' + snap.remainingSec)
const pauseEvents = s.recentEvents(50).filter((e) => e.type === 'phase.pause')
check('pause 事件带时间戳且 source=widget', pauseEvents.length === 1 && pauseEvents[0].t === clock && pauseEvents[0].source === 'widget', pauseEvents[0])

clock += 120000
r = s.command('resume', {}, 'widget')
snap = r.snapshot
check('resume → running, deadline=now+900s', snap.runState === 'running' && snap.deadlineAt === clock + 900000, snap.deadlineAt)
check('累计暂停 120s', snap.pausedTotalSec === 120, snap.pausedTotalSec)

clock += 900000
check('tick 推进阶段', s.tick() === true, null)
snap = s.snapshot()
check('work 完成 → short-break/running(autoBreak)', snap.phase === 'short-break' && snap.runState === 'running', snap.phase + '/' + snap.runState)
const completes = s.recentEvents(50).filter((e) => e.type === 'phase.complete')
check('complete 事件 elapsed=1500 pause=120', completes.length === 1 && completes[0].elapsedSec === 1500 && completes[0].pauseSec === 120, completes[0])
check('今日统计 1 个番茄/1500s/1 次暂停', snap.stats.todayFocusCount === 1 && snap.stats.todayFocusSec === 1500 && snap.stats.todayPauseCount === 1, snap.stats)
check('completedWorkRounds=1 且 workRoundNumber 仍为 1', snap.completedWorkRounds === 1 && snap.workRoundNumber === 1, [snap.completedWorkRounds, snap.workRoundNumber])

s.command('stop', {}, 'widget')
check('stop → idle', s.snapshot().phase === 'idle' && s.snapshot().runState === 'idle', s.snapshot().runState)
check('abandon 事件被记录', s.recentEvents(20).some((e) => e.type === 'phase.abandon'), null)

// ═══ 轮次模型：完整周期 ════════════════════════════════════════════════════
section('轮次模型（roundsPerCycle=4）')
const sCycle = createStore({ dir: join(DIR, 'cycle'), now, config: { autoNextFocus: true } })
sCycle.command('start', { focusMinutes: 1, shortBreakMinutes: 1, longBreakMinutes: 1 }, 'ai')
const seen = []
for (let i = 0; i < 9; i += 1) {
  const before = sCycle.snapshot()
  seen.push(`${before.phase}#${before.workRoundNumber}`)
  clock += 60000
  sCycle.tick()
}
const after9 = sCycle.snapshot()
check(
  '周期序列 work1→short→work2→short→work3→short→work4→long→work1',
  seen.join(' ') === 'work#1 short-break#1 work#2 short-break#2 work#3 short-break#3 work#4 long-break#4 work#1',
  seen.join(' '),
)
check('长休后 workRoundNumber 复位为 1', after9.workRoundNumber === 1, after9.workRoundNumber)
check('completedWorkRounds 累加到 5（4 轮 + 长休后那轮）', after9.completedWorkRounds === 5, after9.completedWorkRounds)
check('sessionWorkCount 单调累加（不随长休重置）', after9.sessionWorkCount === 5, after9.sessionWorkCount)
check('work 段长度=60s（focusMinutes=1）', after9.plannedSec === 60, after9.plannedSec)

section('默认不自动开始下一段（autoNextFocus=false）')
const sManual = createStore({ dir: join(DIR, 'manual'), now, config: { focusMin: 1, shortBreakMin: 1 } })
sManual.command('start', {}, 'ai')
clock += 60000
sManual.tick() // work 完成 → 短休自动开始（autoBreak 默认 true）
check('专注结束自动进休息', sManual.snapshot().phase === 'short-break' && sManual.snapshot().runState === 'running', sManual.snapshot().runState)
clock += 60000
sManual.tick() // 短休完成 → 下一段专注应「停住」等待
check('休息结束不自动开始专注（停在 paused）', sManual.snapshot().phase === 'work' && sManual.snapshot().runState === 'paused', sManual.snapshot().phase + '/' + sManual.snapshot().runState)

section('轮次模型（开关组合）')
const sNoLong = createStore({ dir: join(DIR, 'nolong'), now, config: { focusMin: 1, shortBreakMin: 1, roundsPerCycle: 2, longBreaksEnabled: false, autoNextFocus: true } })
sNoLong.command('start', {}, 'ai')
const seqNoLong = []
for (let i = 0; i < 5; i += 1) {
  seqNoLong.push(`${sNoLong.snapshot().phase}#${sNoLong.snapshot().workRoundNumber}`)
  clock += 60000
  sNoLong.tick()
}
check(
  '长休关掉 → 用短休顶替且周期复位',
  seqNoLong.join(' ') === 'work#1 short-break#1 work#2 short-break#0 work#1',
  seqNoLong.join(' '),
)

const sNoBreaks = createStore({ dir: join(DIR, 'nobreaks'), now, config: { focusMin: 1, roundsPerCycle: 2, shortBreaksEnabled: false, longBreaksEnabled: false, autoNextFocus: true } })
sNoBreaks.command('start', {}, 'ai')
const seqNoBreaks = []
for (let i = 0; i < 4; i += 1) {
  seqNoBreaks.push(`${sNoBreaks.snapshot().phase}#${sNoBreaks.snapshot().workRoundNumber}`)
  clock += 60000
  sNoBreaks.tick()
}
check('两个休息都关 → 纯 work 循环', seqNoBreaks.join(' ') === 'work#1 work#2 work#1 work#2', seqNoBreaks.join(' '))

const sOne = createStore({ dir: join(DIR, 'one'), now, config: { focusMin: 1, longBreakMin: 1, roundsPerCycle: 1, autoNextFocus: true } })
sOne.command('start', {}, 'ai')
const seqOne = []
for (let i = 0; i < 3; i += 1) {
  seqOne.push(sOne.snapshot().phase)
  clock += 60000
  sOne.tick()
}
check('roundsPerCycle=1 → work/long 交替', seqOne.join(' ') === 'work long-break work', seqOne.join(' '))

// ═══ 计划与任务 ════════════════════════════════════════════════════════════
section('计划')
r = s.command('plan.set', { title: '写周报', tasks: [{ title: '收集数据', estimate: 2 }, { title: '成稿', estimate: 1 }] }, 'ai')
snap = r.snapshot
check('plan.set 2 任务 / 估 3 番茄', snap.plan && snap.plan.tasks.length === 2 && snap.planProgress.totalEstimate === 3, snap.planProgress)
check('默认选中第一个任务', snap.taskId === 't1', snap.taskId)
s.command('start', {}, 'ai')
clock += 1500000
s.tick()
snap = s.snapshot()
check('完成 1 个番茄 → 任务 spent=1 未完成(估2)', snap.plan.tasks[0].spent === 1 && snap.plan.tasks[0].done === false, snap.plan.tasks[0])
s.command('stop', {}, 'widget')

// ═══ 跳过 ══════════════════════════════════════════════════════════════════
section('跳过')
s.command('start', {}, 'ai')
clock += 30000
snap = s.command('skip', {}, 'widget').snapshot
check('skip → 进入下一段且停住', snap.phase === 'short-break' && snap.runState === 'paused', snap.phase + '/' + snap.runState)
check('skip 不计入完成数', snap.stats.todayFocusCount === 2, snap.stats.todayFocusCount)
s.command('stop', {}, 'widget')

// ═══ 离线结算 ══════════════════════════════════════════════════════════════
section('离线结算')
s.command('start', {}, 'ai')
clock += 1500000 + 3600000
const s2 = createStore({ dir: DIR, now })
const snap2 = s2.snapshot()
check('离线结算返回 gap≈3600s', s2.offlineSettle && Math.abs(s2.offlineSettle.gapSec - 3600) <= 1, s2.offlineSettle)
check('离线后落在休息段且 paused（不自动空跑）', snap2.runState === 'paused' && snap2.phase.includes('break'), snap2.phase + '/' + snap2.runState)
check('离线只结算一次', s2.recentEvents(500).filter((e) => e.type === 'offline.settle').length === 1, null)
check('离线完成计入统计且标 offline（共 3 个）', snap2.stats.todayFocusCount === 3 && snap2.stats.todayOfflineCount === 1, snap2.stats)
check('离线专注时长按计划时长计（不吞 1h gap）', snap2.stats.todayFocusSec === 4500, snap2.stats)

// ═══ 持久化 ════════════════════════════════════════════════════════════════
section('持久化')
const s3 = createStore({ dir: DIR, now })
const snap3 = s3.snapshot()
check('重启后状态可复原', snap3.phase === snap2.phase && snap3.runState === snap2.runState && snap3.plan.tasks.length === 2, [snap2.phase, snap3.phase])
check('再次创建不再重复结算', s3.offlineSettle === null, s3.offlineSettle)
check('state.json 版本=STATE_VERSION', JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8')).v === STATE_VERSION, [JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8')).v, STATE_VERSION])
check('state.json 无 .tmp 残留', !existsSync(join(DIR, 'state.json.tmp')), null)

// 配置持久化：改了时长/轮次后重启，必须原样保留（否则计时会悄悄回默认值）
section('配置持久化')
const sCfg = createStore({ dir: join(DIR, 'cfg'), now })
sCfg.command('config.set', { patch: { focusMin: 42, shortBreakMin: 9, longBreakMin: 21, roundsPerCycle: 3, tickDuringWork: true } }, 'ai')
const sCfg2 = createStore({ dir: join(DIR, 'cfg'), now })
const cfg2 = sCfg2.snapshot()
check('重启后 focusMin 保留', cfg2.config.focusMin === 42, cfg2.config.focusMin)
check('重启后 longBreakMin / roundsPerCycle 保留', cfg2.config.longBreakMin === 21 && cfg2.config.roundsPerCycle === 3, cfg2.config)
check('重启后开关保留', cfg2.config.tickDuringWork === true, cfg2.config.tickDuringWork)
sCfg2.command('start', {}, 'ai')
check('重启后时长真的按 42 分钟计', sCfg2.snapshot().plannedSec === 42 * 60, sCfg2.snapshot().plannedSec)
const rawEvents = readFileSync(join(DIR, 'events.jsonl'), 'utf8').trim().split('\n')
let allParsed = true
for (const line of rawEvents) {
  try {
    JSON.parse(line)
  } catch {
    allParsed = false
  }
}
check('events.jsonl 每行都是合法 JSON', allParsed && rawEvents.length > 10, rawEvents.length)

// ═══ 周统计 ════════════════════════════════════════════════════════════════
section('周统计')
const week = s3.snapshot().week
check('本周返回 7 天', week.days.length === 7, week.days.length)
check('最后一天=今天', week.days[6].day === new Date(clock).toISOString().slice(0, 10) || week.days[6].day.endsWith('-01'), week.days[6].day)
check('周合计 ≥ 今日', week.totals.focusCount >= s3.snapshot().stats.todayFocusCount, [week.totals, s3.snapshot().stats])
check('每日行字段齐全', week.days.every((d) => 'focusCount' in d && 'focusSec' in d && 'pauseCount' in d && 'day' in d), week.days[0])

// 跨天：把事件写到另一天，确认按本地自然日切分
const sDay = createStore({ dir: join(DIR, 'days'), now })
sDay.command('start', { focusMinutes: 1 }, 'ai')
clock += 60000
sDay.tick()
const dayBefore = sDay.snapshot().stats.todayFocusCount
clock += 86400000 // 跳到第二天
const afterDay = sDay.snapshot()
check('跨天后今日计数归零', afterDay.stats.todayFocusCount === 0 && dayBefore === 1, [dayBefore, afterDay.stats.todayFocusCount])
check('跨天后周合计仍含昨天', afterDay.week.totals.focusCount === 1, afterDay.week.totals)

// ═══ 背景音 ════════════════════════════════════════════════════════════════
section('背景音')
// ═══ 管家会话 ══════════════════════════════════════════════════════════════
section('管家会话')
const sMgr = createStore({ dir: join(DIR, 'manager'), now })
check('默认没有管家（谁都没有工具）', sMgr.snapshot().manager.sessionId === null, sMgr.snapshot().manager)
check('默认没有提醒目标', sMgr.snapshot().reminderTarget === null, sMgr.snapshot().reminderTarget)
r = sMgr.command('manager.set', { sessionId: 'sess-A' }, 'human')
check('可以指定管家', r.ok === true && r.snapshot.manager.sessionId === 'sess-A', r.snapshot.manager)
check('管家同时成为提醒目标', r.snapshot.reminderTarget === 'sess-A', r.snapshot.reminderTarget)
check('管家变化会留下事件', sMgr.recentEvents(5).some((e) => e.type === 'manager.set'), sMgr.recentEvents(3).map((e) => e.type))
r = sMgr.command('manager.set', { sessionId: 'sess-B' }, 'human')
check('可以换管家', r.snapshot.manager.sessionId === 'sess-B' && r.snapshot.reminderTarget === 'sess-B', r.snapshot.manager)
const sMgr2 = createStore({ dir: join(DIR, 'manager'), now })
check('管家会持久化（重启后仍在）', sMgr2.snapshot().manager.sessionId === 'sess-B', sMgr2.snapshot().manager)
r = sMgr2.command('manager.set', { sessionId: '   ' }, 'human')
check('空白 id 视为解除', r.ok === true && r.snapshot.manager.sessionId === null, r.snapshot.manager)
check('解除后提醒目标回退到上次绑定', r.snapshot.reminderTarget === 'sess-B', r.snapshot.reminderTarget)
const sNoise = createStore({ dir: join(DIR, 'noise'), now })
r = sNoise.command('noise.set', { on: true, master: 0.5 }, 'ai')
snap = r.snapshot
check('背景音开 + 总音量', snap.noise.on === true && snap.noise.master === 0.5, snap.noise)
check('合成噪音已整块移除（noise 里没有 synth）', snap.noise.synth === undefined, Object.keys(snap.noise))
check('旧字段 patch.synth 被静默忽略（不报错也不生效）', sNoise.command('noise.set', { synth: { mode: 'brown' } }, 'ai').ok === true && sNoise.snapshot().noise.synth === undefined, null)
r = sNoise.command('noise.set', { addLoop: { id: 'rain', volume: 0.3 } }, 'ai')
r = sNoise.command('noise.set', { addLoop: { id: 'fire-campfire', volume: 0.2 } }, 'ai')
snap = r.snapshot
check('两路环境音可叠加', snap.noise.loops.length === 2 && snap.noise.loops[0].id === 'rain', snap.noise.loops)
check('重复添加同 id 幂等', sNoise.command('noise.set', { addLoop: { id: 'rain' } }, 'ai').snapshot.noise.loops.length === 2, null)
// 简写形状也必须能用：浮层发的是字符串，两端契约不一致曾导致 bad_loop_id（2026-10-02 实测）
r = sNoise.command('noise.set', { addLoop: 'stream' }, 'ai')
check('addLoop 支持字符串简写（浮层契约）', r.ok === true && r.snapshot.noise.loops.some((x) => x.id === 'stream'), r.ok ? r.snapshot.noise.loops : r.error)
check('简写形状用默认音量 0.375', r.snapshot.noise.loops.find((x) => x.id === 'stream').volume === 0.375, r.snapshot.noise.loops)
check('非法 loop id 被拒', sNoise.command('noise.set', { addLoop: { id: '../etc' } }, 'ai').ok === false, null)
check('非法 loop id（字符串形状）也被拒', sNoise.command('noise.set', { addLoop: '../etc' }, 'ai').ok === false, null)
snap = sNoise.command('noise.set', { setLoopVolume: { id: 'rain', volume: 0.9 } }, 'ai').snapshot
check('单路音量可调', snap.noise.loops.find((x) => x.id === 'rain').volume === 0.9, snap.noise.loops)
snap = sNoise.command('noise.set', { removeLoop: 'fire-campfire' }, 'ai').snapshot
check('可移除单路', snap.noise.loops.length === 2 && !snap.noise.loops.some((x) => x.id === 'fire-campfire'), snap.noise.loops)
snap = sNoise.command('noise.set', { music: { on: true, channelId: 'ch-1', volume: 0.5 } }, 'ai').snapshot
check('音乐频道可开', snap.noise.music.on && snap.noise.music.channelId === 'ch-1', snap.noise.music)
snap = sNoise.command('noise.set', { music: { channelId: 'ch-2' } }, 'ai').snapshot
check('换频道会重置曲目序号', snap.noise.music.trackIndex === 0 && snap.noise.music.channelId === 'ch-2', snap.noise.music)
snap = sNoise.command('noise.set', { clearLoops: true }, 'ai').snapshot
check('可一次清空环境音', snap.noise.loops.length === 0, null)

// ═══ v1 状态迁移 ═══════════════════════════════════════════════════════════
section('v1 → v2 迁移')
writeFileSync(
  join(DIR_V1, 'state.json'),
  JSON.stringify({
    v: 1,
    phase: 'focus',
    runState: 'paused',
    taskId: null,
    roundIndex: 3,
    plannedSec: 1500,
    remainingSec: 900,
    pausedAt: null,
    pausedTotalSec: 0,
    startedAt: null,
    deadlineAt: null,
    plan: null,
    watchSessionId: 'session-x',
    config: { focusMin: 30, breakMin: 7, autoBreak: false, noiseVolume: 0.25 },
    noise: { on: true, mode: 'rain', volume: 0.25, trackIndex: 2 },
  }) + '\n',
  'utf8',
)
const sV1 = createStore({ dir: DIR_V1, now })
const v1 = sV1.snapshot()
check('phase focus → work', v1.phase === 'work', v1.phase)
check('breakMin → shortBreakMin=7', v1.config.shortBreakMin === 7, v1.config.shortBreakMin)
check('roundIndex → workRoundNumber', v1.workRoundNumber === 3 && v1.completedWorkRounds === 3, [v1.workRoundNumber, v1.completedWorkRounds])
check('v1 的合成噪音 mode 无处可搬 → 干净丢弃', v1.noise.synth === undefined, Object.keys(v1.noise))
check('noiseVolume → master=0.25', v1.noise.master === 0.25, v1.noise.master)
check('迁移后回写为 STATE_VERSION', JSON.parse(readFileSync(join(DIR_V1, 'state.json'), 'utf8')).v === STATE_VERSION, [JSON.parse(readFileSync(join(DIR_V1, 'state.json'), 'utf8')).v, STATE_VERSION])
check('watch 会话保留', v1.watch.sessionId === 'session-x', v1.watch)

// ═══ 坏输入 ════════════════════════════════════════════════════════════════
section('坏输入')
const sBad = createStore({ dir: join(DIR, 'bad'), now })
check('未知动作被拒', sBad.command('nope', {}, 'ai').ok === false, null)
check('未运行时 pause 被拒', sBad.command('pause', {}, 'ai').ok === false, null)
check('idle 时 stop 被拒', sBad.command('stop', {}, 'ai').ok === false, null)
check('idle 时 skip 被拒', sBad.command('skip', {}, 'ai').ok === false, null)
check('不存在的任务被拒', s.command('plan.select', { taskId: 'zzz' }, 'ai').ok === false, null)
check('无读取错误（loadError 为空）', sBad.loadError === null, sBad.loadError)

// ═══ 汇总 ══════════════════════════════════════════════════════════════════
let failed = 0
for (const c of checks) {
  if (c.section) {
    console.log('\n── ' + c.section + ' ' + '─'.repeat(Math.max(0, 46 - c.section.length)))
    continue
  }
  if (!c.pass) failed += 1
  console.log((c.pass ? '  ✓ ' : '  ✗ ') + c.name + (c.pass ? '' : '  → ' + JSON.stringify(c.extra)))
}
const total = checks.filter((c) => !c.section).length
console.log(`\n${total - failed}/${total} 通过`)
process.exit(failed === 0 ? 0 : 1)
