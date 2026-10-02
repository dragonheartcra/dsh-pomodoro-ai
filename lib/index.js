/**
 * @dsh-external/dsh-pomodoro-ai — host 半。
 *
 * 分工：本文件只做「把内核接到 DSH 上」（路由 / tick / 工具 / 到点通知），
 * 状态机与持久化全在 lib/store.js。
 *
 * 可测性设计：工具与路由都抽成**不依赖 ctx 的工厂函数**（createTools / createApiHandler），
 * 所以 `node tools/host-smoke.mjs` 能脱离 DSH 直接跑它们（用假 req/res）。
 * 这很重要——官方装配下改 host 代码必须重启 DSH 才生效，能提前验证就别等重启。
 *
 * 硬约束：
 * 1. 本包没有 node_modules，只能 import `node:*` 与同目录相对路径。
 * 2. 工具 schema 必须是完整 JSON Schema：`parameters: {}` 会被 openai-completions
 *    通道原样透传、上游 400 拒绝，**挂掉全应用所有会话**（2026-10-02 事故）。
 *    三道闸：assertToolSchema（注册前）→ register（进**管家会话的 scope**）→ 回读隔离校验
 *    （该 scope 里工具齐全，且全局视图里一个都没有）。
 * 3. 资源注册一律挂 ctx.effect；并且有单例守卫（同包被装配两次时第二份直接跳过）。
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createStore } from './store.js'

export const name = '@dsh-external/dsh-pomodoro-ai'
export const inject = ['tools', 'webServer']

const BUILD = 'phase4-8'
const ROUTE = '/pomodoro-ai/api'
const TOOL_PREFIX = 'pomodoro_'
const INSTANCE_KEY = Symbol.for('@dsh-external/dsh-pomodoro-ai.instance')

/**
 * 静态资源根目录（FlowTunes 数据 / 环境音图标 / 提示音）。
 *
 * 本插件**不含任何第三方资产**，这些文件必须由使用者自己提供，三种方式任选：
 *   1. 环境变量 `POMODORO_STATIC` 指向你的 static 目录；
 *   2. 把文件放进 `$DSH_HOME/pomodoro/{flowtunes,loop-icons,audio}`；
 *   3. 用 `config.set` 显式指定 `flowDataDir` / `loopIconsDir` / `cueDir`。
 * 缺了不影响计时本身：环境音/图标/提示音各自降级（路由 404、界面提示缺哪些文件）。
 */
const STATIC_ROOT = process.env.POMODORO_STATIC || ''
/** FlowTunes 公共桶（音频运行时从网络流式播放，插件包内不含任何第三方资产）。 */
export const AUDIO_BASE = 'https://uaugvlfehjnmqwcsscnp.supabase.co/storage/v1/object/public'
export const TRACK_URL_TEMPLATE = `${AUDIO_BASE}/track-audio-v3/mds/{id}.m4a`
export const LOOP_URL_TEMPLATE = `${AUDIO_BASE}/loop-audio-v3/{id}.m4a`

export const CUE_NAMES = ['alert-work', 'alert-short-break', 'alert-long-break', 'tick']
const AUDIO_EXT = ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac', '.opus']

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readBody(req, limit = 262144) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

/** 闸 1：注册前校验（空 parameters 会挂掉全站，见文件头注释）。 */
export function assertToolSchema(tool) {
  const where = `[pomodoro-ai] 工具 ${tool?.name ?? '(无名)'}`
  const p = tool?.parameters
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.type !== 'object') {
    throw new Error(`${where} 的 parameters 必须是 {type:'object',properties:{...}}（空对象会被上游 400 拒绝并挂掉所有会话）`)
  }
  if (!p.properties || typeof p.properties !== 'object' || Array.isArray(p.properties)) {
    throw new Error(`${where} 的 parameters.properties 必须是对象（无参数也要写 properties: {}）`)
  }
  for (const [key, value] of Object.entries(p.properties)) {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
      throw new Error(`${where} 的参数 ${key} 缺 type`)
    }
  }
  if (p.required !== undefined && !Array.isArray(p.required)) {
    throw new Error(`${where} 的 parameters.required 必须是数组`)
  }
  const out = tool?.output
  if (!out || typeof out !== 'object' || !out.schema || typeof out.schema !== 'object' || typeof out.render !== 'function') {
    throw new Error(`${where} 缺 output.schema / output.render`)
  }
  if (typeof tool.execute !== 'function') throw new Error(`${where} 缺 execute`)
  return tool
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const PHASE_LABEL = { work: '专注', 'short-break': '短休', 'long-break': '长休', idle: '待开始' }

// ═══════════════════════════════════════════════════════════════════════════
// FlowTunes 数据加载（工厂：按 mtime 缓存，可脱离 DSH 测试）
// ═══════════════════════════════════════════════════════════════════════════
export function createFlowLoader(getDirs) {
  const jsonCache = new Map()
  const readJson = (file) => {
    try {
      const st = statSync(file)
      const hit = jsonCache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.value
      const value = JSON.parse(readFileSync(file, 'utf8'))
      jsonCache.set(file, { mtimeMs: st.mtimeMs, value })
      return value
    } catch {
      return null
    }
  }

  return async function loadFlowData() {
    const dirs = getDirs()
    const missing = []
    const channels = readJson(join(dirs.flowDataDir, 'channels.json'))
    if (!channels) missing.push('channels.json')
    const catalog = readJson(join(dirs.flowDataDir, 'catalog.json'))
    if (!catalog) missing.push('catalog.json')
    const ambient = readJson(join(dirs.flowDataDir, 'ambient.json'))
    if (!ambient) missing.push('ambient.json')

    let localTracks = []
    try {
      localTracks = readdirSync(dirs.musicDir)
        .filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()))
        .slice(0, 500)
        .map((f) => ({ name: f, url: `${ROUTE}/audio/${encodeURIComponent(f)}` }))
    } catch {
      /* 目录不存在＝没有本地音乐 */
    }

    return {
      channels: channels ?? [],
      catalog: catalog ?? { tracks: {} },
      ambient: ambient ?? { sounds: [], categories: [] },
      local: { tracks: localTracks, channelId: 'local' },
      missing,
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具面（工厂：不依赖 ctx，可脱离 DSH 测试）
// ═══════════════════════════════════════════════════════════════════════════
export function createTools(deps) {
  const { store, resolveSessionId, loadFlowData, record, managerId } = deps

  /**
   * 第二道闸：只有「管家会话」能调用这些工具。
   *
   * 实测（2026-10-02）：正常派发路径下 `exec.agent.id` 一定有值（管家调用成功了）；
   * 但 `tools.presentAs('ptc')` 之类的替代派发路径不保证带 agent 身份。
   * 所以"身份缺失"时**放行**——因为可见性那层（工具只注册进管家 scope）已经保证了
   * 只有管家会话能看见并调用它；这里拒绝反而会在替代路径上把管家自己挡死。
   * 第一次遇到身份缺失会记一条 probe，便于发现。
   */
  let warnedNoIdentity = false
  const denied = (exec) => {
    const wanted = typeof managerId === 'function' ? managerId() : null
    if (!wanted) {
      return '番茄钟还没有指定「管家会话」：请在想管理番茄钟的那个会话里由人输入 `/pomodoro 接管`。其他会话看不到这些工具是设计如此。'
    }
    const sessionId = exec?.agent?.id ?? null
    if (sessionId === wanted) return null
    if (sessionId === null) {
      if (!warnedNoIdentity) {
        warnedNoIdentity = true
        record('tools.call-without-agent', { wanted })
      }
      return null
    }
    return `番茄钟只在指定的「管家会话」里可用（当前会话 ${sessionId} 不是管家，管家是 ${wanted}）。由人在目标会话里输入 \`/pomodoro 接管\` 可以把身份搬过去。`
  }

  const roundLine = (snap) =>
    `${PHASE_LABEL[snap.phase] ?? snap.phase} · 第 ${snap.workRoundNumber}/${snap.roundsPerCycle} 个番茄` +
    (snap.nextRoundHint === 'long-break' ? '（下一个是长休）' : '') +
    ` · 今日 ${snap.stats.todayFocusCount} 个`

  return [
    {
      name: 'pomodoro_plan',
      description: '登记番茄计划：把任务拆解与每项番茄数估算写进番茄钟，浮层部件会显示。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划名，如「写周报」' },
          tasks: {
            type: 'array',
            description: '任务清单（顺序即执行顺序）',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '任务名' },
                estimate: { type: 'integer', description: '预计番茄数，默认 1' },
                notes: { type: 'string', description: '可选备注' },
              },
              required: ['title'],
            },
          },
        },
        required: ['tasks'],
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const d = denied(exec)
        if (d) return d
        const result = store.command('plan.set', args ?? {}, 'ai')
        if (!result.ok) return '登记失败：' + result.error
        const snap = result.snapshot
        const lines = snap.plan.tasks.map((t) => `- ${t.title}（${t.estimate} 个番茄）`)
        return `已登记计划「${snap.plan.title}」，共 ${snap.planProgress.totalEstimate} 个番茄：\n${lines.join('\n')}\n当前任务：${snap.taskTitle ?? '（无）'}`
      },
    },
    {
      name: 'pomodoro_start',
      description: '启动番茄钟：开始专注，可指定任务、时长、每轮几个番茄与是否自动接休息。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要专注的任务 id（来自 pomodoro_plan）' },
          focusMinutes: { type: 'integer', description: '专注时长（分钟），默认 25' },
          shortBreakMinutes: { type: 'integer', description: '短休时长（分钟），默认 5' },
          longBreakMinutes: { type: 'integer', description: '长休时长（分钟），默认 15' },
          roundsPerCycle: { type: 'integer', description: '几个番茄后进长休，默认 4' },
          autoBreak: { type: 'boolean', description: '专注结束是否自动开始休息' },
          autoNextFocus: { type: 'boolean', description: '休息结束是否自动开始下一个番茄' },
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const d = denied(exec)
        if (d) return d
        const sessionId = exec?.agent?.id
        if (sessionId) store.command('session.bind', { sessionId }, 'ai')
        const result = store.command('start', args ?? {}, 'ai')
        if (!result.ok) return '启动失败：' + result.error
        const snap = result.snapshot
        return `番茄钟已启动：专注 ${Math.round(snap.plannedSec / 60)} 分钟，任务「${snap.taskTitle ?? '未指定'}」。${roundLine(snap)}。到点会通知你（投递到本会话）。`
      },
    },
    {
      name: 'pomodoro_control',
      description: '控制番茄钟：暂停/继续/跳过/停止/重置，或改轮次与时长配置。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'resume', 'skip', 'stop', 'reset', 'config', 'rounds.reset'], description: '要执行的动作' },
          focusMin: { type: 'integer', description: 'action=config：专注默认时长' },
          shortBreakMin: { type: 'integer', description: 'action=config：短休时长' },
          longBreakMin: { type: 'integer', description: 'action=config：长休时长' },
          roundsPerCycle: { type: 'integer', description: 'action=config：几轮后长休' },
          shortBreaksEnabled: { type: 'boolean', description: 'action=config：是否要短休' },
          longBreaksEnabled: { type: 'boolean', description: 'action=config：是否要长休' },
          autoBreak: { type: 'boolean', description: 'action=config：自动进休息' },
          autoNextFocus: { type: 'boolean', description: 'action=config：休息后自动开始下一段' },
          notifyOnPhaseEnd: { type: 'boolean', description: 'action=config：阶段结束是否通知你' },
          cueVolume: { type: 'number', description: 'action=config：提示音音量 0-1' },
          tickDuringWork: { type: 'boolean', description: 'action=config：专注中滴答声' },
          tickDuringBreak: { type: 'boolean', description: 'action=config：休息中滴答声' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const d = denied(exec)
        if (d) return d
        const action = String(args?.action ?? '')
        const payload = args ?? {}
        const result = action === 'config' ? store.command('config.set', { patch: payload }, 'ai') : store.command(action, payload, 'ai')
        if (!result.ok) return `操作失败（${action}）：` + result.error
        const snap = result.snapshot
        return `${action} 完成。当前：${roundLine(snap)}，剩余 ${snap.remainingSec}s，任务「${snap.taskTitle ?? '未指定'}」。`
      },
    },
    {
      name: 'pomodoro_status',
      description: '读取番茄钟权威状态、今日与本周统计、最近阶段事件（含暂停时间点）。',
      parameters: {
        type: 'object',
        properties: {
          events: { type: 'integer', description: '附带最近事件条数，默认 12，上限 100' },
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const d = denied(exec)
        if (d) return d
        const snap = store.snapshot()
        const limit = Number.isFinite(Number(args?.events)) ? Math.max(0, Math.min(100, Number(args.events))) : 12
        const events = limit > 0 ? store.recentEvents(limit) : []
        const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })
        const lines = events.map((e) => {
          const extra = []
          if (e.remainingSec !== undefined) extra.push(`剩余${e.remainingSec}s`)
          if (e.elapsedSec !== undefined) extra.push(`已专注${e.elapsedSec}s`)
          if (e.pauseSec) extra.push(`暂停${e.pauseSec}s`)
          if (e.offline) extra.push('关机期间走完(无法核实)')
          return `${fmt(e.t)}  ${e.type}  [${e.source}]  ${extra.join(' ')}`
        })
        const week = snap.week
        const weekBars = week.days.map((d) => `${d.day.slice(5)}:${d.focusCount}`).join(' ')
        return [
          `阶段：${PHASE_LABEL[snap.phase] ?? snap.phase} / ${snap.runState}`,
          `轮次：第 ${snap.workRoundNumber}/${snap.roundsPerCycle} 个番茄（本会话累计 ${snap.sessionWorkCount} 段，共完成 ${snap.completedWorkRounds} 个）${snap.nextRoundHint === 'long-break' ? '，下一个是长休' : ''}`,
          `剩余：${snap.remainingSec}s（计划 ${snap.plannedSec}s，本段已累计暂停 ${snap.pausedTotalSec}s）`,
          `当前任务：${snap.taskTitle ?? '（未指定）'}`,
          snap.plan ? `计划「${snap.plan.title}」进度 ${snap.planProgress.totalSpent}/${snap.planProgress.totalEstimate}` : '计划：未登记',
          `今日：${snap.stats.todayFocusCount} 个番茄 / ${Math.round(snap.stats.todayFocusSec / 60)} 分钟 / 暂停 ${snap.stats.todayPauseCount} 次${snap.stats.todayOfflineCount ? ` / 离线结算 ${snap.stats.todayOfflineCount}` : ''}`,
          `近 7 天：共 ${week.totals.focusCount} 个 / ${Math.round(week.totals.focusSec / 60)} 分钟　（${weekBars}）`,
          `配置：专注 ${snap.config.focusMin}m，短休 ${snap.config.shortBreakMin}m，长休 ${snap.config.longBreakMin}m，每 ${snap.config.roundsPerCycle} 轮长休，自动休息 ${snap.config.autoBreak ? '开' : '关'}，阶段通知 ${snap.config.notifyOnPhaseEnd ? '开' : '关'}`,
          `背景音：${snap.noise.on ? '开' : '关'}（环境音 ${snap.noise.loops.map((l) => l.id).join('+') || '无'}，音乐 ${snap.noise.music.on ? snap.noise.music.channelId : '关'}）`,
          '',
          `最近 ${lines.length} 条事件（时间 / 类型 / 来源）：`,
          ...lines,
        ].join('\n')
      },
    },
    {
      name: 'pomodoro_noise',
      description: '背景音控制：先 action=list 看可用音源，再 action=set 开关环境音/音乐。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set'], description: 'list=列出可用音源与当前状态；set=修改' },
          on: { type: 'boolean', description: 'set：总开关' },
          master: { type: 'number', description: 'set：总音量 0-1' },
          ambientRatio: { type: 'number', description: 'set：环境音比例 0-1' },
          addLoop: { type: 'string', description: 'set：叠加一路环境音（用 list 返回的 id）' },
          removeLoop: { type: 'string', description: 'set：移除一路环境音' },
          loopVolume: { type: 'number', description: 'set：配合 addLoop 设该路音量；单独用则设所有环境音音量' },
          clearLoops: { type: 'boolean', description: 'set：清空所有环境音' },
          musicOn: { type: 'boolean', description: 'set：音乐开关' },
          channelId: { type: 'string', description: 'set：音乐频道 id（用 list 返回的 id）' },
          trackIndex: { type: 'integer', description: 'set：跳到频道内第几首' },
          musicVolume: { type: 'number', description: 'set：音乐音量 0-1' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const d = denied(exec)
        if (d) return d
        const action = String(args?.action ?? 'list')
        if (action === 'list') {
          const data = await loadFlowData()
          const sounds = (data.ambient?.sounds ?? []).map((s) => s.id + (s.title ? `(${s.title})` : ''))
          const cats = (data.ambient?.categories ?? []).map((c) => `${c.id}:${(c.loopIds ?? []).join('|')}`)
          const channels = (data.channels ?? []).map((c) => `${c.id}(${c.title})`)
          const local = data.local?.tracks?.length ?? 0
          const snap = store.snapshot()
          return [
            `当前背景音：${snap.noise.on ? '开' : '关'}，总音量 ${snap.noise.master}，环境音比例 ${snap.noise.ambientRatio}`,
            `已叠加环境音：${snap.noise.loops.map((l) => `${l.id}@${l.volume}`).join(', ') || '（无）'}`,
            `音乐：${snap.noise.music.on ? '开' : '关'}${snap.noise.music.channelId ? ` @ ${snap.noise.music.channelId} #${snap.noise.music.trackIndex}` : ''}`,
            '',
            `可用环境音 id（${sounds.length}）：${sounds.join(', ')}`,
            cats.length ? `环境音分类：${cats.join('　')}` : '',
            `可用音乐频道（${channels.length}）：${channels.join(', ')}`,
            local > 0 ? `本地音乐文件夹另有 ${local} 首（频道 id = local）` : '本地音乐文件夹：空',
            data.missing?.length ? `⚠ 缺失数据文件：${data.missing.join(', ')}（在 config.flowDataDir 指定目录）` : '',
          ].filter(Boolean).join('\n')
        }

        const patch = {}
        if (args.on !== undefined) patch.on = Boolean(args.on)
        if (args.master !== undefined) patch.master = args.master
        if (args.ambientRatio !== undefined) patch.ambientRatio = args.ambientRatio
        if (args.addLoop !== undefined) patch.addLoop = { id: args.addLoop, volume: args.loopVolume }
        else if (args.loopVolume !== undefined) {
          const snap = store.snapshot()
          patch.loops = snap.noise.loops.map((l) => ({ id: l.id, volume: args.loopVolume }))
        }
        if (args.removeLoop !== undefined) patch.removeLoop = args.removeLoop
        if (args.clearLoops) patch.clearLoops = true
        if (args.musicOn !== undefined || args.channelId !== undefined || args.trackIndex !== undefined || args.musicVolume !== undefined) {
          patch.music = {}
          if (args.musicOn !== undefined) patch.music.on = Boolean(args.musicOn)
          if (args.channelId !== undefined) patch.music.channelId = args.channelId
          if (args.trackIndex !== undefined) patch.music.trackIndex = args.trackIndex
          if (args.musicVolume !== undefined) patch.music.volume = args.musicVolume
        }
        const result = store.command('noise.set', patch, 'ai')
        if (!result.ok) return '背景音设置失败：' + result.error
        const n = result.snapshot.noise
        return `已更新。背景音 ${n.on ? '开' : '关'}；环境音 ${n.loops.map((l) => `${l.id}@${l.volume}`).join('+') || '无'}；音乐 ${n.music.on ? n.music.channelId : '关'}。`
      },
    },
  ]
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 路由（工厂：不依赖 ctx）
// ═══════════════════════════════════════════════════════════════════════════
export function createApiHandler(deps) {
  const { store, record, paths, loadFlowData } = deps

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const txt = typeof body === 'string' ? body : JSON.stringify(body)
    try {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(txt)
    } catch {
      /* 对端已关闭 */
    }
  }

  /** 流式发文件，支持 Range（音频拖动进度条要用）。 */
  const sendFile = (req, res, filePath, contentType) => {
    let stat
    try {
      stat = statSync(filePath)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      return send(res, 404, { ok: false, error: 'not_found' })
    }
    const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    const range = req.headers?.range
    const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (match) {
      const size = stat.size
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])
      if (start === null && end !== null) {
        start = Math.max(0, size - end)
        end = size - 1
      } else {
        start = start ?? 0
        end = end === null ? size - 1 : Math.min(end, size - 1)
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
      return createReadStream(filePath, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
    return createReadStream(filePath).pipe(res)
  }

  const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus', '.svg': 'image/svg+xml' }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const dirs = paths()

    if (path === '/health') {
      const snap = store.snapshot()
      return send(res, 200, {
        ok: true,
        name,
        build: BUILD,
        version: BUILD,
        ts: Date.now(),
        pid: process.pid,
        stateDir: store.dir,
        hasSchedule: Boolean(deps.getSchedule?.()),
        phase: snap.phase,
        runState: snap.runState,
        workRoundNumber: snap.workRoundNumber,
        roundsPerCycle: snap.roundsPerCycle,
        dirs,
      })
    }

    if (path === '/state') return send(res, 200, store.snapshot())

    if (path === '/events') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      return send(res, 200, { ok: true, events: store.recentEvents(Number.isFinite(limit) ? limit : 50) })
    }

    if (path === '/command') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' })
      const raw = await readBody(req)
      let body = null
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        return send(res, 400, { ok: false, error: 'bad_json' })
      }
      const source = body?.source === 'ai' ? 'ai' : 'widget'
      const result = store.command(String(body?.action ?? ''), body?.payload ?? {}, source)
      return send(res, result.ok ? 200 : 400, result)
    }

    // FlowTunes 数据（从本地目录读；插件包内不含任何第三方资产）
    if (path === '/flow/data') {
      const data = await loadFlowData()
      return send(res, 200, { ok: true, audioBase: AUDIO_BASE, trackUrlTemplate: TRACK_URL_TEMPLATE, loopUrlTemplate: LOOP_URL_TEMPLATE, ...data, dirs })
    }

    if (path.startsWith('/flow/icon/')) {
      const id = basename(path.slice('/flow/icon/'.length))
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) return send(res, 400, { ok: false, error: 'bad_id' })
      return sendFile(req, res, join(dirs.loopIconsDir, `${id}.svg`), MIME['.svg'])
    }

    if (path.startsWith('/cue/')) {
      const id = basename(path.slice('/cue/'.length))
      if (!CUE_NAMES.includes(id)) return send(res, 404, { ok: false, error: 'unknown_cue' })
      for (const ext of AUDIO_EXT) {
        const file = join(dirs.cueDir, id + ext)
        if (existsSync(file)) return sendFile(req, res, file, MIME[ext] ?? 'application/octet-stream')
      }
      return send(res, 404, { ok: false, error: 'cue_file_missing', dir: dirs.cueDir })
    }

    if (path.startsWith('/audio/')) {
      const name = basename(decodeURIComponent(path.slice('/audio/'.length)))
      const ext = extname(name).toLowerCase()
      if (!AUDIO_EXT.includes(ext)) return send(res, 400, { ok: false, error: 'bad_ext' })
      return sendFile(req, res, join(dirs.musicDir, name), MIME[ext] ?? 'application/octet-stream')
    }

    if (path === '/probe' && req.method === 'POST') {
      const raw = await readBody(req)
      let parsed = null
      try {
        parsed = JSON.parse(raw || '{}')
      } catch {
        parsed = { unparsed: raw.slice(0, 2000) }
      }
      record('client.probe', parsed)
      return send(res, 200, { ok: true, stored: true, build: BUILD })
    }

    return send(res, 404, { ok: false, error: 'not_found', path })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 装配
// ═══════════════════════════════════════════════════════════════════════════
export function apply(ctx) {
  // 单例守卫：同包被装配两次时（官方 bundles 与运行时 entry 撞车），
  // 第二份会在重名处抛错，但它已生效的订阅会各自武装提醒 → 重复通知。
  const existingInstance = globalThis[INSTANCE_KEY]
  if (existingInstance) {
    ctx.logger?.warn?.('[pomodoro-ai] 已有实例在运行（build=%s），本次 build=%s 跳过重复装配', existingInstance.build, BUILD)
    return
  }
  const instanceToken = { build: BUILD, pid: process.pid, at: Date.now() }
  globalThis[INSTANCE_KEY] = instanceToken
  ctx.effect(() => () => {
    if (globalThis[INSTANCE_KEY] === instanceToken) delete globalThis[INSTANCE_KEY]
  }, 'pomodoro-ai: instance guard')

  const home = dshHome()
  const dir = join(home, 'pomodoro')
  const probeFile = join(dir, 'probe.jsonl')
  mkdirSync(dir, { recursive: true })

  const record = (kind, data) => {
    try {
      appendFileSync(probeFile, JSON.stringify({ t: Date.now(), kind, build: BUILD, ...data }) + '\n')
    } catch {
      /* 观测失败不影响主流程 */
    }
  }

  // 默认目录：先看 POMODORO_STATIC 下的三个子目录，没有就退回 $DSH_HOME/pomodoro/*
  const staticRoot = STATIC_ROOT || join(dir, 'static')
  const defaults = {
    flowDataDir: existsSync(join(staticRoot, 'flowtunes')) ? join(staticRoot, 'flowtunes') : join(dir, 'flowtunes'),
    loopIconsDir: existsSync(join(staticRoot, 'loop-icons')) ? join(staticRoot, 'loop-icons') : join(dir, 'loop-icons'),
    cueDir: existsSync(join(staticRoot, 'audio')) ? join(staticRoot, 'audio') : join(dir, 'audio'),
    musicDir: join(dir, 'music'),
  }

  const store = createStore({ dir, config: defaults })
  // 已持久化的配置优先；只为「空值」补默认目录
  const fill = {}
  for (const [key, value] of Object.entries(defaults)) if (!store.snapshot().config[key]) fill[key] = value
  if (Object.keys(fill).length > 0) store.command('config.set', { patch: fill }, 'system')

  const getSchedule = () => {
    try {
      return ctx.get('schedule')
    } catch {
      return undefined
    }
  }

  /** 提醒投递目标：管家会话优先（语义上"这只钟归谁管"），回退到最近一次启动它的会话。 */
  const resolveSessionId = () => {
    const snap = store.snapshot()
    const bound = snap.reminderTarget
    if (bound) return bound
    try {
      const agents = ctx.get('agents')
      const live = agents?.list?.() ?? []
      return live.length > 0 ? live[live.length - 1].id : null
    } catch {
      return null
    }
  }

  /**
   * 这个会话是不是「管家」——返回当前管家 id（没有则 null）。
   *
   * 工具已经按 scope 注册（别人根本看不见），这里是**第二道**：万一可见性被绕过
   * （工具清单被缓存、模型幻觉出一个它看不见的工具名），execute 仍然拒绝。
   * 注意 `tools.execute()` 对不可见工具本身就返回 UNKNOWN_TOOL，所以可见性才是主闸。
   */
  const managerId = () => store.snapshot().manager.sessionId

  // ── FlowTunes 数据读取（目录取自当前配置，按 mtime 缓存）─────────────────
  const paths = () => {
    const cfg = store.snapshot().config
    return {
      flowDataDir: cfg.flowDataDir || defaults.flowDataDir,
      loopIconsDir: cfg.loopIconsDir || defaults.loopIconsDir,
      cueDir: cfg.cueDir || defaults.cueDir,
      musicDir: cfg.musicDir || defaults.musicDir,
    }
  }
  const loadFlowData = createFlowLoader(paths)

  record('host.apply', {
    pid: process.pid,
    node: process.version,
    dshHome: home,
    stateDir: dir,
    hasSchedule: Boolean(getSchedule()),
    dirs: defaults,
    offlineSettle: store.offlineSettle,
    loadError: store.loadError,
  })

  // ── 到点通知（串行链：arm/disarm 交错会漏删，见下方注释）──────────────────
  let armed = null
  let reminderChain = Promise.resolve()
  const serializeReminderOp = (op) => {
    reminderChain = reminderChain.then(op).catch((error) => record('schedule.op-failed', { message: String(error) }))
    return reminderChain
  }

  const disarmNow = async (why) => {
    const schedule = getSchedule()
    if (!schedule || !armed) return
    const target = armed
    armed = null
    try {
      await schedule.delete({ sessionId: target.sessionId, id: target.id })
      record('schedule.disarmed', { why, id: target.id })
    } catch (error) {
      record('schedule.disarm-failed', { why, message: String(error) })
    }
  }

  const consumeNow = (why) => {
    if (!armed) return
    record('schedule.consumed', { why, id: armed.id })
    armed = null
  }

  const armNow = async (snap, why) => {
    const schedule = getSchedule()
    if (!schedule || !snap.config.notifyOnPhaseEnd) return
    if (snap.phase === 'idle' || snap.runState !== 'running' || !snap.deadlineAt) return
    const sessionId = resolveSessionId()
    if (!sessionId) {
      record('schedule.skipped', { why, reason: 'no_session' })
      return
    }
    await disarmNow('rearm')
    const afterSec = Math.max(1, Math.ceil((snap.deadlineAt - Date.now()) / 1000))
    const label = PHASE_LABEL[snap.phase] ?? snap.phase
    const tail = snap.phase === 'work' ? '据此决定下一步：进入休息、继续下一段、还是收尾，并简短告诉我。' : '据此决定是否开始下一段专注，并简短告诉我。'
    try {
      const rec = await schedule.create(sessionId, {
        title: `${snap.phase === 'work' ? '🍅' : snap.phase === 'long-break' ? '🌿' : '☕'} ${label}结束`,
        prompt: `${snap.phase === 'work' ? '🍅' : '☕'} 番茄钟的${label}段到点了（第 ${snap.workRoundNumber}/${snap.roundsPerCycle} 个番茄）。请调用 pomodoro_status 读取权威状态（实际时长、暂停次数与时间点都在里面），${tail}`,
        after_seconds: afterSec,
      })
      armed = { id: rec.id, sessionId, phase: snap.phase }
      record('schedule.armed', { id: rec.id, sessionId, afterSec, phase: snap.phase, why })
    } catch (error) {
      record('schedule.arm-failed', { message: String(error), sessionId, afterSec })
    }
  }

  const disarmReminder = (why) => serializeReminderOp(() => disarmNow(why))
  const consumeReminder = (why) => serializeReminderOp(async () => consumeNow(why))
  const armReminder = (snap, why) => serializeReminderOp(() => armNow(snap, why))

  const restoreReminderOnLoad = async () => {
    const schedule = getSchedule()
    if (!schedule) return
    const sessionId = resolveSessionId()
    if (sessionId) {
      try {
        const catalog = await schedule.catalog()
        for (const row of catalog) {
          if (row.status !== 'active' || row.sessionId !== sessionId) continue
          if (!/^[🍅☕🌿]/.test(String(row.title ?? ''))) continue
          await schedule.delete({ sessionId, id: row.id })
          record('schedule.swept', { id: row.id, title: row.title })
        }
      } catch (error) {
        record('schedule.sweep-failed', { message: String(error) })
      }
    }
    const snap = store.snapshot()
    if (snap.phase !== 'idle' && snap.runState === 'running') await armNow(snap, 'restore-after-load')
  }

  ctx.effect(() => store.subscribe((event) => {
    if (!event.type.startsWith('phase.') && event.type !== 'offline.settle') return
    record('phase.event', { type: event.type, source: event.source, phase: event.phase, t: event.t })
    const snap = store.snapshot()
    if (event.type === 'phase.start') void armReminder(snap, 'phase-start')
    else if (event.type === 'phase.complete') void consumeReminder('phase-complete')
    else if (['phase.pause', 'phase.abandon', 'phase.skip', 'phase.reset'].includes(event.type)) void disarmReminder(event.type)
    else if (event.type === 'phase.resume') void armReminder(snap, 'phase-resume')
  }), 'pomodoro-ai: event trace + reminder wiring')

  /**
   * 等 schedule 服务就绪后再恢复提醒。
   *
   * 实测（2026-10-02 重启验证）：加载顺序是「bundle 层（本插件）→ profile patch 层
   * （schedule 那条 insert）」，所以 apply 时 `ctx.get('schedule')` 还是 undefined
   * （probe 里 host.apply 记的是 hasSchedule:false，而 47 秒后 /health 已是 true）。
   * 若在这里直接返回，「运行中重启 DSH」这一段的结束通知就会永远缺席。
   */
  const waitForScheduleThenRestore = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (getSchedule()) {
        await serializeReminderOp(restoreReminderOnLoad)
        return
      }
      await new Promise((resolve) => {
        const id = setTimeout(resolve, 1500)
        if (id && typeof id.unref === 'function') id.unref()
      })
    }
    record('schedule.restore-skipped', { reason: 'service_not_ready', attempts: 10 })
  }

  void waitForScheduleThenRestore()

  ctx.effect(() => {
    const id = setInterval(() => {
      try {
        store.tick()
      } catch (error) {
        record('tick.error', { message: String(error) })
      }
    }, 1000)
    if (id && typeof id.unref === 'function') id.unref()
    return () => clearInterval(id)
  }, 'pomodoro-ai: tick')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: createApiHandler({ store, record, paths, loadFlowData, getSchedule }),
  }), 'pomodoro-ai: api route')

  // ═══════════════════════════════════════════════════════════════════════════
  // 工具面：**只注册进「管家会话」的 agent scope**，不再全局注册
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 为什么要这样（用户诉求）：DSH 里同时跑很多项目的会话，只有**一个**会话该管番茄钟。
  // 全局注册的代价是三重的：每个会话的请求都带这 5 个 schema（白付 token）、
  // 任何会话都能 pomodoro_start 抢走绑定、任何会话都能操作全局唯一的那只钟。
  //
  // 官方机制（cordis_inspect 查到的精确契约，不是推测）：
  //  - `tools.register()`：*"Register globally **or in the calling agent scope**"*
  //  - `tools.schemas(scope?)` / `get(name, scope?)`：*"the viewing scope (**the agent**)"*
  //  - `tools.execute()`：*"an **invisible** tool reports `UNKNOWN_TOOL`"*
  //  - 事件 `agent/created`（serial）：*"ready for **per-agent initialization**"*
  // 所以把注册动作放在 `agent.ctx` 上调用，工具就只属于那个会话；别人连 schema 都拿不到，
  // 硬调也只会得到 UNKNOWN_TOOL。全局那只钟（store/tick/路由/提醒）照旧是单例。
  const tools = createTools({ store, resolveSessionId, loadFlowData, record, managerId })

  /** sessionId → { dispose[] }：当前挂在哪个会话的 scope 上（**最多一个**）。 */
  const mounted = new Map()
  /** 离线记录去重：对账器每 15s 跑一轮，不然 probe 会被刷满。 */
  let offlineLoggedFor = null

  function unmountTools(sessionId, why) {
    const entry = mounted.get(sessionId)
    if (!entry) return
    mounted.delete(sessionId)
    for (const dispose of entry.dispose) {
      try {
        dispose()
      } catch {
        /* 单个 disposer 失败不影响其它 */
      }
    }
    record('tools.unmounted', { sessionId, why, count: entry.dispose.length })
  }

  function unmountAll(why) {
    for (const sessionId of [...mounted.keys()]) unmountTools(sessionId, why)
  }

  /**
   * 把 5 个工具挂进某个 agent 的 scope。
   * 失败一律**闭嘴**（记 probe），因为 `agent/created` 是 serial 派发——
   * 监听器抛错会让整个 agent 创建失败，那代价太大。
   */
  function mountToolsFor(agent, why) {
    if (!agent || typeof agent.id !== 'string') return false
    if (mounted.has(agent.id)) return true
    const target = agent.ctx
    if (!target || typeof target.tools?.register !== 'function') {
      record('tools.mount-failed', { sessionId: agent.id, why, reason: 'no_agent_ctx' })
      return false
    }
    const dispose = []
    try {
      for (const tool of tools) {
        dispose.push(target.tools.register(assertToolSchema(tool)))
      }
      // 回读：**管家自己的 scope 里有、全局视图里一个都没有**（隔离不变量）
      const scoped = target.tools.schemas(agent)
      const globalView = ctx.tools.schemas()
      const scopedNames = scoped.map((s) => s.name).filter((n) => n.startsWith(TOOL_PREFIX))
      const leaked = globalView.map((s) => s.name).filter((n) => n.startsWith(TOOL_PREFIX))
      if (scopedNames.length !== tools.length) {
        throw new Error(`scoped 视图只有 ${scopedNames.length}/${tools.length} 个工具`)
      }
      if (leaked.length > 0) {
        throw new Error(`工具泄漏到全局视图：${leaked.join(', ')}`)
      }
      mounted.set(agent.id, { dispose })
      record('tools.mounted', { sessionId: agent.id, why, names: scopedNames })
      return true
    } catch (error) {
      for (const d of dispose) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
      record('tools.mount-failed', { sessionId: agent.id, why, reason: String(error) })
      return false
    }
  }

  /** 按当前管家会话重新挂载（配置变化、启动、agent 建立/销毁都走这里）。 */
  function syncToolsToManager(why) {
    const wanted = store.snapshot().manager.sessionId
    for (const sessionId of [...mounted.keys()]) {
      if (sessionId !== wanted) unmountTools(sessionId, why + ':not-manager')
    }
    if (!wanted) return
    let agent = null
    try {
      agent = ctx.get('agents')?.get?.(wanted) ?? null
    } catch {
      agent = null
    }
    if (agent) {
      offlineLoggedFor = null
      mountToolsFor(agent, why)
    } else if (offlineLoggedFor !== wanted) {
      // 只在"进入离线"时记一次：对账器每 15s 跑一轮，不然 probe 会被刷满
      offlineLoggedFor = wanted
      record('tools.manager-offline', { sessionId: wanted, why })
    }
  }

  /**
   * 对账器：只在实际状态与期望不符时才动作（幂等、便宜）。
   *
   * 为什么需要它 —— `agent/created` 已验证会触发（实测 spawn 子代理时记到了 agent.created），
   * 但仍有两条路径不靠它兜底：
   *  1. 启动时 `ctx.get('agents')` 可能还没就绪（schedule 就踩过同样的加载顺序问题）；
   *  2. 插件重载期间管家会话一直是"已存在"状态，不会再触发 created。
   * 15 秒一轮的兜底把"事件没等到"这一整类风险消掉。
   */
  ctx.effect(() => {
    const reconcile = () => {
      try {
        const wanted = store.snapshot().manager.sessionId
        if (!wanted) {
          if (mounted.size > 0) syncToolsToManager('reconcile:no-manager')
          return
        }
        if (mounted.has(wanted)) return
        syncToolsToManager('reconcile')
      } catch (error) {
        record('tools.reconcile-failed', { message: String(error) })
      }
    }
    const id = setInterval(reconcile, 15000)
    if (id && typeof id.unref === 'function') id.unref()
    return () => clearInterval(id)
  }, 'pomodoro-ai: tools reconciler')

  // 每个会话建立（含 resume）时做一次按需挂载
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent) return
      const wanted = store.snapshot().manager.sessionId
      record('agent.created', { sessionId: agent.id, source: payload?.source, isManager: agent.id === wanted })
      if (agent.id === wanted) mountToolsFor(agent, 'agent-created')
    } catch (error) {
      // serial 监听器抛错会让 agent 创建失败 —— 这里必须吞掉
      record('agent.created.handler-failed', { message: String(error) })
    }
  }), 'pomodoro-ai: per-agent tool mounting')

  ctx.effect(() => ctx.on('agent/disposed', (payload) => {
    try {
      const id = payload?.agent?.id
      if (id) unmountTools(id, 'agent-disposed')
    } catch (error) {
      record('agent.disposed.handler-failed', { message: String(error) })
    }
  }), 'pomodoro-ai: per-agent tool cleanup')

  // 管家变化 → 立刻改挂载
  ctx.effect(() => store.subscribe((event) => {
    if (event.type === 'manager.set') syncToolsToManager('manager-changed')
  }), 'pomodoro-ai: manager watch')

  // 启动时：为已在线的管家会话挂上
  void serializeReminderOp(async () => syncToolsToManager('startup'))

  // ═══════════════════════════════════════════════════════════════════════════
  // 人类命令：指定「哪个会话当番茄钟管家」
  // ═══════════════════════════════════════════════════════════════════════════
  // `invocation.agent` 就是**输入这条命令的那个会话** —— 这正是"指定管家"需要的入口，
  // 而且命令是给人用的，模型侧看不到（不占工具 schema）。
  function commandHandler(invocation) {
    try {
      const agent = invocation?.agent
      const sessionId = agent?.id ?? null
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      const snap = store.snapshot()
      const current = snap.manager.sessionId
      if (['接管', 'claim', 'on', 'take'].includes(arg)) {
        if (!sessionId) return { kind: 'error', text: '拿不到当前会话 id，无法接管。' }
        const res = store.command('manager.set', { sessionId }, 'human')
        if (!res.ok) return { kind: 'error', text: '接管失败：' + res.error }
        syncToolsToManager('command-claim')
        const okNow = mounted.has(sessionId)
        record('manager.claimed', { sessionId, mounted: okNow })
        return {
          kind: 'success',
          text: okNow
            ? `已接管：从现在起**只有这个会话**能看见番茄钟工具（其他会话连 schema 都没有）。\n现在可以对我说「帮我拆一下 XXX」或「开始一个 25 分钟的番茄」。`
            : `已记下这个会话是管家，但工具挂载没成功（会话可能刚建立）。发一条消息后再试，或看 ~/.dsh/pomodoro/probe.jsonl 里的 tools.mount-failed。`,
        }
      }
      if (['释放', 'release', 'off', 'none'].includes(arg)) {
        store.command('manager.set', { sessionId: null }, 'human')
        syncToolsToManager('command-release')
        record('manager.released', {})
        return { kind: 'success', text: '已释放：所有会话都不再看见番茄钟工具（那只钟还在跑，浮层照常显示）。' }
      }
      // 无参数 / 状态
      const lines = [
        `管家会话：${current ?? '（未指定——所有会话都看不见番茄钟工具）'}`,
        current ? `当前会话：${sessionId}${current === sessionId ? ' ← 就是管家' : '（不是管家）'}` : `当前会话：${sessionId ?? '未知'}`,
        `工具挂载：${mounted.size > 0 ? [...mounted.keys()].join(', ') : '（无）'}`,
        `计时：${snap.phase} / ${snap.runState}，今日 ${snap.stats.todayFocusCount} 个番茄`,
        '',
        '用法：`/pomodoro 接管` 让当前会话成为管家；`/pomodoro 释放` 解除；`/pomodoro` 看状态。',
      ]
      return { kind: 'success', text: lines.join('\n') }
    } catch (error) {
      record('manager.command-failed', { message: String(error) })
      return { kind: 'error', text: '番茄钟命令出错：' + String(error) }
    }
  }

  ctx.effect(() => {
    const dispose = []
    const registered = []
    try {
      const commands = ctx.get('commands')
      if (commands && typeof commands.register === 'function') {
        // 命令名有硬约束：^[a-z][a-z0-9_-]*$ —— 中文名会被拒（实测报错
        // `command name "番茄钟" must match /^[a-z][a-z0-9_-]*$/u`），所以只用 ASCII，
        // 中文说明放进 description 与 input.hint。
        for (const cmdName of ['pomodoro', 'pomo']) {
          try {
            dispose.push(commands.register({
              name: cmdName,
              description: '番茄钟管家：接管=让本会话管理番茄钟（其他会话看不见工具）｜释放｜状态',
              input: { hint: '接管 | 释放 | 状态' },
              handler: commandHandler,
            }))
            registered.push(cmdName)
          } catch (error) {
            record('commands.register-failed', { cmdName, message: String(error) })
          }
        }
        if (registered.length > 0) record('commands.registered', { names: registered })
      } else {
        record('commands.unavailable', {})
      }
    } catch (error) {
      record('commands.failed', { message: String(error) })
    }
    return () => {
      for (const d of dispose) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'pomodoro-ai: manager command')

  ctx.effect(() => () => unmountAll('plugin-dispose'), 'pomodoro-ai: tools cleanup')

  ctx.logger?.info?.('[pomodoro-ai] host 就绪 build=%s（%s，schedule=%s）', BUILD, ROUTE, Boolean(getSchedule()))
}
