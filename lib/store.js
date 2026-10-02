/**
 * 番茄钟内核：纯逻辑 + 落盘，**不依赖任何 DSH 服务**。
 *
 * 这样切分是为了可验证性：lib/index.js 只做「把内核接到 DSH 上」（路由/工具/调度），
 * 状态机、持久化、统计可以脱离 DSH 直接跑回归测试：`node tools/smoke.mjs`。
 *
 * 两条时间语义：
 *  - 计时用绝对时间戳（deadlineAt），不做累加 tick，避免漂移；
 *  - 「今天/本周」按**本地自然日**切分（localDayKey），不是 UTC。
 *
 * 轮次模型移植自 elegant-pomodoro 的 sequence.rs：
 *   work → short-break → … → work(第 N 轮) → long-break → work(第 1 轮) …
 *   长短休各自可关；长休关掉时用短休顶替；两个都关就是纯 work 循环。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_VERSION = 3

export const DEFAULT_CONFIG = {
  // 轮次
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsPerCycle: 4,
  shortBreaksEnabled: true,
  longBreaksEnabled: true,
  autoBreak: true,
  autoNextFocus: false,
  // 通知与提示音
  notifyOnPhaseEnd: true,
  cueVolume: 0.7,
  tickDuringWork: false,
  tickDuringBreak: false,
  // 音源目录（FlowTunes 逆向数据 / loop 图标 / 本地音乐 / 提示音）
  flowDataDir: '',
  loopIconsDir: '',
  musicDir: '',
  cueDir: '',
}

/** 同时叠加的环境音上限。 */
export const MAX_LOOPS = 8

const EVENT_MEMORY_CAP = 5000
const WEEK_DAYS = 7

export const WORK_PHASES = ['work', 'focus'] // focus 是 v1 的历史值

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 历史 phase 值归一：v1 的 focus/break → v2 的 work/short-break。 */
export function normalizePhase(phase) {
  if (phase === 'focus') return 'work'
  if (phase === 'break') return 'short-break'
  return phase
}

export function isWorkPhase(phase) {
  return WORK_PHASES.includes(phase)
}

/** 本地自然日键（YYYY-MM-DD），用于「今日 / 本周」统计。 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 从某天起往前 n 天的本地日键（含当天），从旧到新。 */
export function recentDayKeys(ms, n = WEEK_DAYS) {
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) out.push(localDayKey(ms - i * 86400000))
  return out
}

function freshNoise(config) {
  return {
    on: false,
    master: 0.6,
    ambientRatio: 1,
    loops: [],
    music: { on: false, channelId: null, trackIndex: 0, volume: 0.6 },
  }
}

function freshState(t, config) {
  return {
    v: STATE_VERSION,
    phase: 'idle',
    runState: 'idle',
    taskId: null,
    // 轮次：workRoundNumber 是「本轮第几个」（1..roundsPerCycle，界面显示用），
    // completedWorkRounds 单调累加（不随长休重置），sessionWorkCount 同单调。
    workRoundNumber: 1,
    completedWorkRounds: 0,
    sessionWorkCount: 1,
    plannedSec: config.focusMin * 60,
    startedAt: null,
    deadlineAt: null,
    pausedAt: null,
    pausedTotalSec: 0,
    remainingSec: config.focusMin * 60,
    plan: null,
    config,
    watchSessionId: null,
    /**
     * 管家会话：**只有这个会话的 AI 看得见番茄钟工具**（工具按 scope 注册进它的 agent ctx）。
     * 由人类命令 `/番茄钟 接管` 指定。null = 谁都没有工具（避免"所有会话都带着番茄钟"）。
     */
    managerSessionId: null,
    noise: freshNoise(config),
  }
}

/** 环境音列表净化（模块级：迁移与命令都要用）。 */
function normalizeLoops(input) {
  if (!Array.isArray(input)) return null
  const out = []
  for (const item of input.slice(0, MAX_LOOPS)) {
    const id = typeof item?.id === 'string' ? item.id.trim().slice(0, 64) : ''
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) continue
    if (out.some((x) => x.id === id)) continue
    out.push({ id, volume: clampNum(item?.volume, 0, 1, 0.375) })
  }
  return out
}

/** 旧版本状态迁移到当前 STATE_VERSION（无损：能搬的都搬）。 */
function migrate(raw, config) {
  const next = { ...raw }
  next.v = STATE_VERSION
  next.phase = normalizePhase(raw.phase)
  const cfg = { ...(raw.config ?? {}) }
  if (cfg.breakMin !== undefined && cfg.shortBreakMin === undefined) cfg.shortBreakMin = cfg.breakMin
  delete cfg.breakMin
  delete cfg.noiseMode
  delete cfg.noiseVolume
  next.config = { ...config, ...cfg }

  const oldNoise = raw.noise ?? {}
  next.noise = freshNoise(next.config)
  // v1 用 volume / mode / trackIndex；v2 起已是 master / ambientRatio / loops / music。
  // 两条都要搬，否则 v2 → v3 会把用户已选的环境音和音乐频道清空（实测差点踩到）。
  const legacyVolume = oldNoise.volume ?? oldNoise.master
  if (legacyVolume !== undefined) next.noise.master = clampNum(legacyVolume, 0, 1, next.noise.master)
  if (oldNoise.ambientRatio !== undefined) next.noise.ambientRatio = clampNum(oldNoise.ambientRatio, 0, 1, next.noise.ambientRatio)
  const loops = normalizeLoops(oldNoise.loops)
  if (loops) next.noise.loops = loops
  if (oldNoise.music && typeof oldNoise.music === 'object') next.noise.music = { ...next.noise.music, ...oldNoise.music }
  // v1 语义：mode='music' 表示当时在放音乐；trackIndex 是频道内曲目序号。
  // （v1 的合成噪音 mode=white/brown/rain 已随该功能移除，无处可搬。）
  if (oldNoise.mode === 'music') next.noise.music.on = Boolean(oldNoise.on)
  if (oldNoise.trackIndex !== undefined) next.noise.music.trackIndex = clampInt(oldNoise.trackIndex, 0, 9999, next.noise.music.trackIndex)
  next.noise.on = Boolean(oldNoise.on)

  if (next.workRoundNumber === undefined) next.workRoundNumber = clampInt(raw.roundIndex, 1, 99, 1)
  if (next.completedWorkRounds === undefined) next.completedWorkRounds = clampInt(raw.roundIndex, 0, 9999, 0)
  if (next.sessionWorkCount === undefined) next.sessionWorkCount = next.completedWorkRounds + 1
  delete next.roundIndex
  return next
}

/**
 * 建一个 store。
 * @param {{dir: string, now?: () => number, config?: object}} options
 */
export function createStore(options) {
  const dir = options.dir
  const now = options.now ?? (() => Date.now())
  const stateFile = join(dir, 'state.json')
  const eventsFile = join(dir, 'events.jsonl')

  mkdirSync(dir, { recursive: true })

  let config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) }
  let migrationPending = false
  let loadError = null
  let state = loadState()
  // 让闭包里的 config 与「载入的状态」一致。
  // 不同步的话，重启后 phaseSeconds() 会拿默认值算时长——持久化的配置被静默忽略
  // （v1 就埋着这个 bug，直到 v1→v2 迁移测试才暴露）。
  config = { ...config, ...state.config }
  state.config = config
  // 迁移后立刻回写一次，避免每次启动都迁移。
  // 注意：不能在 loadState 内部写 state —— 那时 `let state` 还在 TDZ，
  // 赋值会抛 ReferenceError 并被 catch 吞掉，表现为「迁移静默失效」。
  if (migrationPending) writeState()
  let events = loadEvents()
  const listeners = new Set()

  function loadState() {
    try {
      if (!existsSync(stateFile)) return freshState(now(), config)
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return freshState(now(), config)
      const base = freshState(now(), config)
      const migrated = raw.v === STATE_VERSION ? raw : migrate(raw, config)
      if (raw.v !== STATE_VERSION) migrationPending = true
      const n = migrated.noise ?? {}
      return {
        ...base,
        ...migrated,
        config: { ...base.config, ...(migrated.config ?? {}) },
        // noise 显式挑字段：旧版本残留的键（如已移除的 synth）不会跟着进来
        noise: {
          on: Boolean(n.on),
          master: clampNum(n.master, 0, 1, base.noise.master),
          ambientRatio: clampNum(n.ambientRatio, 0, 1, base.noise.ambientRatio),
          loops: Array.isArray(n.loops) ? n.loops.slice(0, MAX_LOOPS) : [],
          music: { ...base.noise.music, ...(n.music ?? {}) },
        },
      }
    } catch (error) {
      // 状态文件损坏：不猜，回到干净初态（旧文件仍在盘上可人工检查）。
      // 但把原因留下来——否则编程错误会被这里静默吞掉。
      loadError = String(error && error.stack ? error.stack : error)
      return freshState(now(), config)
    }
  }

  function loadEvents() {
    try {
      if (!existsSync(eventsFile)) return []
      const lines = readFileSync(eventsFile, 'utf8').split('\n')
      const out = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          out.push(JSON.parse(trimmed))
        } catch {
          /* 跳过半行（写入中断） */
        }
      }
      return out.slice(-EVENT_MEMORY_CAP)
    } catch {
      return []
    }
  }

  /** 原子写：临时文件 + rename，避免半个 JSON 留在盘上。 */
  function writeState() {
    const tmp = stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, stateFile)
  }

  function emit(type, extra, source) {
    const event = { t: now(), type, source: source ?? 'system', phase: state.phase, ...extra }
    events.push(event)
    if (events.length > EVENT_MEMORY_CAP) events = events.slice(-EVENT_MEMORY_CAP)
    try {
      appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8')
    } catch {
      /* 事件落盘失败不影响内存态 */
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* 监听器异常不能影响状态机 */
      }
    }
    return event
  }

  function currentTask() {
    if (!state.plan || !state.taskId) return null
    return state.plan.tasks.find((task) => task.id === state.taskId) ?? null
  }

  function phaseSeconds(phase) {
    if (phase === 'work') return config.focusMin * 60
    if (phase === 'long-break') return config.longBreakMin * 60
    return config.shortBreakMin * 60
  }

  /** 计算剩余秒（running 用 deadline 推，其余用冻结值）。 */
  function remainingSec() {
    if (state.runState === 'running' && state.deadlineAt) {
      return Math.max(0, Math.ceil((state.deadlineAt - now()) / 1000))
    }
    return Math.max(0, Math.round(state.remainingSec))
  }

  function elapsedOf() {
    if (state.startedAt === null) return 0
    const end = state.runState === 'running' && state.deadlineAt ? now() : (state.pausedAt ?? now())
    return Math.max(0, Math.round((end - state.startedAt) / 1000 - state.pausedTotalSec))
  }

  function enterPhase(phase, autoStart, source, reason) {
    state.phase = phase
    state.plannedSec = phaseSeconds(phase)
    state.remainingSec = state.plannedSec
    state.startedAt = null
    state.pausedAt = null
    state.pausedTotalSec = 0
    if (autoStart) {
      state.runState = 'running'
      state.startedAt = now()
      state.deadlineAt = state.startedAt + state.plannedSec * 1000
    } else {
      state.runState = 'paused'
      state.deadlineAt = null
    }
    emit('phase.start', {
      plannedSec: state.plannedSec,
      auto: true,
      reason,
      taskId: state.taskId,
      round: state.workRoundNumber,
      workRoundNumber: state.workRoundNumber,
      roundsPerCycle: config.roundsPerCycle,
      completedWorkRounds: state.completedWorkRounds,
    }, source)
  }

  /**
   * 轮次推进（移植 sequence.rs 的语义）。
   * 注意 workRoundNumber=0 那个技巧：长休关掉时用短休顶替，
   * 置 0 是为了让「短休 → work」的 +1 正好回到 1，保持周期边界不变量。
   */
  function advanceRound(finished) {
    let next
    if (finished === 'work') {
      if (state.workRoundNumber >= config.roundsPerCycle) {
        if (config.longBreaksEnabled) next = 'long-break'
        else if (config.shortBreaksEnabled) {
          state.workRoundNumber = 0
          next = 'short-break'
        } else {
          state.workRoundNumber = 1
          next = 'work'
        }
      } else if (config.shortBreaksEnabled) {
        next = 'short-break'
      } else {
        state.workRoundNumber += 1
        next = 'work'
      }
    } else if (finished === 'short-break') {
      state.workRoundNumber += 1
      next = 'work'
    } else {
      state.workRoundNumber = 1
      next = 'work'
    }
    if (next === 'work') state.sessionWorkCount += 1
    return next
  }

  function settleCompletedPhase(source, offline) {
    // 离线结算时「专注时长」只能算计划时长——关机期间人到底在不在干活无法核实，
    // 把 gap 算进专注时长是不诚实的统计（gap 另由 offline.settle 事件记录）。
    const elapsedSec = offline ? state.plannedSec : elapsedOf()
    const finished = state.phase
    emit('phase.complete', {
      plannedSec: state.plannedSec,
      elapsedSec,
      pauseSec: Math.round(state.pausedTotalSec),
      taskId: state.taskId,
      round: state.workRoundNumber,
      workRoundNumber: state.workRoundNumber,
      offline: Boolean(offline),
    }, source)

    if (finished === 'work') {
      state.completedWorkRounds += 1
      const task = currentTask()
      if (task) {
        task.spent = (task.spent ?? 0) + 1
        if (task.spent >= (task.estimate ?? 1)) task.done = true
      }
    }

    const next = advanceRound(finished)
    // 离线结算时不自动启动下一段：人不在，别让休息/专注在后台空跑。
    const auto = offline ? false : (next === 'work' ? Boolean(config.autoNextFocus) : Boolean(config.autoBreak))
    enterPhase(next, auto, 'system', `${finished}-complete`)
  }

  // ── 离线结算：DSH 关闭期间到点的阶段，启动时「结算一次」，绝不链式连跑 ──
  function settleOffline() {
    if (state.runState !== 'running' || !state.deadlineAt) return null
    const t = now()
    if (t < state.deadlineAt) return null
    const gapSec = Math.round((t - state.deadlineAt) / 1000)
    emit('offline.settle', { phase: state.phase, plannedSec: state.plannedSec, gapSec }, 'settle')
    settleCompletedPhase('settle', true)
    writeState()
    return { gapSec }
  }

  // ── 统计聚合（今日 + 本周）────────────────────────────────────────────────
  function aggregate() {
    const byDay = new Map()
    const row = (key) => {
      let r = byDay.get(key)
      if (!r) {
        r = { day: key, focusCount: 0, focusSec: 0, pauseCount: 0, offlineCount: 0, rounds: 0 }
        byDay.set(key, r)
      }
      return r
    }
    for (const event of events) {
      const r = row(localDayKey(event.t))
      if (event.type === 'phase.complete') {
        if (isWorkPhase(event.phase)) {
          r.focusCount += 1
          r.focusSec += Number(event.elapsedSec) || 0
          if (event.offline) r.offlineCount += 1
        } else if (event.phase === 'long-break') r.rounds += 1
      }
      if (event.type === 'phase.pause') r.pauseCount += 1
    }
    return byDay
  }

  function emptyRow(key) {
    return { day: key, focusCount: 0, focusSec: 0, pauseCount: 0, offlineCount: 0, rounds: 0 }
  }

  function statsSnapshot() {
    const t = now()
    const byDay = aggregate()
    const todayKey = localDayKey(t)
    const today = byDay.get(todayKey) ?? emptyRow(todayKey)
    const days = recentDayKeys(t, WEEK_DAYS).map((key) => byDay.get(key) ?? emptyRow(key))
    const totals = days.reduce(
      (acc, d) => ({
        focusCount: acc.focusCount + d.focusCount,
        focusSec: acc.focusSec + d.focusSec,
        pauseCount: acc.pauseCount + d.pauseCount,
        offlineCount: acc.offlineCount + d.offlineCount,
      }),
      { focusCount: 0, focusSec: 0, pauseCount: 0, offlineCount: 0 },
    )
    return {
      today: {
        todayFocusCount: today.focusCount,
        todayFocusSec: today.focusSec,
        todayPauseCount: today.pauseCount,
        todayOfflineCount: today.offlineCount,
      },
      week: { days, totals, dayCount: days.length },
    }
  }

  // ── 命令 ────────────────────────────────────────────────────────────────
  const commands = {
    start(payload, source) {
      if (state.runState === 'running') return fail('already_running')
      if (state.runState === 'paused' && state.phase !== 'idle' && !payload?.restart) {
        return commands.resume(payload, source)
      }
      let phase = normalizePhase(payload?.phase)
      if (!['work', 'short-break', 'long-break'].includes(phase)) phase = 'work'
      if (payload?.focusMinutes !== undefined) config.focusMin = clampInt(payload.focusMinutes, 1, 240, config.focusMin)
      if (payload?.shortBreakMinutes !== undefined) config.shortBreakMin = clampInt(payload.shortBreakMinutes, 1, 240, config.shortBreakMin)
      if (payload?.breakMinutes !== undefined) config.shortBreakMin = clampInt(payload.breakMinutes, 1, 240, config.shortBreakMin)
      if (payload?.longBreakMinutes !== undefined) config.longBreakMin = clampInt(payload.longBreakMinutes, 1, 240, config.longBreakMin)
      if (payload?.roundsPerCycle !== undefined) config.roundsPerCycle = clampInt(payload.roundsPerCycle, 1, 12, config.roundsPerCycle)
      if (payload?.autoBreak !== undefined) config.autoBreak = Boolean(payload.autoBreak)
      if (payload?.autoNextFocus !== undefined) config.autoNextFocus = Boolean(payload.autoNextFocus)
      if (payload?.taskId !== undefined && state.plan) {
        const task = state.plan.tasks.find((x) => x.id === payload.taskId)
        if (!task) return fail('task_not_found')
        state.taskId = task.id
      }
      state.config = config
      state.phase = phase
      state.plannedSec = phaseSeconds(phase)
      state.remainingSec = state.plannedSec
      state.startedAt = now()
      state.runState = 'running'
      state.deadlineAt = state.startedAt + state.plannedSec * 1000
      state.pausedAt = null
      state.pausedTotalSec = 0
      emit('phase.start', {
        plannedSec: state.plannedSec,
        auto: false,
        taskId: state.taskId,
        round: state.workRoundNumber,
        workRoundNumber: state.workRoundNumber,
        roundsPerCycle: config.roundsPerCycle,
        focusMin: config.focusMin,
        shortBreakMin: config.shortBreakMin,
        longBreakMin: config.longBreakMin,
        autoBreak: config.autoBreak,
      }, source)
      return ok()
    },

    pause(payload, source) {
      if (state.runState !== 'running') return fail('not_running')
      state.remainingSec = remainingSec()
      state.pausedAt = now()
      state.deadlineAt = null
      state.runState = 'paused'
      emit('phase.pause', {
        phase: state.phase,
        remainingSec: state.remainingSec,
        elapsedSec: elapsedOf(),
        taskId: state.taskId,
        round: state.workRoundNumber,
      }, source)
      return ok()
    },

    resume(payload, source) {
      if (state.runState !== 'paused' || state.phase === 'idle') return fail('not_paused')
      const t = now()
      if (state.pausedAt) state.pausedTotalSec += Math.max(0, (t - state.pausedAt) / 1000)
      state.pausedAt = null
      state.runState = 'running'
      state.deadlineAt = t + Math.max(0, state.remainingSec) * 1000
      emit('phase.resume', {
        phase: state.phase,
        remainingSec: state.remainingSec,
        pausedSec: Math.round(state.pausedTotalSec),
        taskId: state.taskId,
        round: state.workRoundNumber,
      }, source)
      return ok()
    },

    /** 跳过：不算完成（不计入统计），按轮次推进到下一段并停住。 */
    skip(payload, source) {
      if (state.phase === 'idle') return fail('idle')
      const from = state.phase
      emit('phase.skip', {
        phase: from,
        remainingSec: remainingSec(),
        elapsedSec: elapsedOf(),
        taskId: state.taskId,
        round: state.workRoundNumber,
      }, source)
      const next = advanceRound(from)
      enterPhase(next, false, source, `${from}-skipped`)
      return ok()
    },

    /** 停止：中断当前阶段回到 idle；记一条 abandon（如实记录中断）。 */
    stop(payload, source) {
      if (state.phase === 'idle' && state.runState === 'idle') return fail('idle')
      emit('phase.abandon', {
        phase: state.phase,
        remainingSec: remainingSec(),
        elapsedSec: elapsedOf(),
        pauseSec: Math.round(state.pausedTotalSec),
        taskId: state.taskId,
        round: state.workRoundNumber,
      }, source)
      state.phase = 'idle'
      state.runState = 'idle'
      state.plannedSec = phaseSeconds('work')
      state.remainingSec = state.plannedSec
      state.startedAt = null
      state.deadlineAt = null
      state.pausedAt = null
      state.pausedTotalSec = 0
      return ok()
    },

    /** 重置：当前阶段回到满时长并停住。 */
    reset(payload, source) {
      if (state.phase === 'idle') return fail('idle')
      state.plannedSec = phaseSeconds(state.phase)
      state.remainingSec = state.plannedSec
      state.runState = 'paused'
      state.startedAt = null
      state.deadlineAt = null
      state.pausedAt = null
      state.pausedTotalSec = 0
      emit('phase.reset', { phase: state.phase, plannedSec: state.plannedSec, taskId: state.taskId }, source)
      return ok()
    },

    /** 把轮次计数归零（换一天/换一批活时用）。 */
    'rounds.reset'(payload, source) {
      state.workRoundNumber = 1
      state.sessionWorkCount = 1
      emit('rounds.reset', {}, source)
      return ok()
    },

    'plan.set'(payload, source) {
      const tasks = Array.isArray(payload?.tasks) ? payload.tasks : []
      const normalized = tasks
        .filter((task) => task && typeof task.title === 'string' && task.title.trim())
        .slice(0, 50)
        .map((task, index) => ({
          id: typeof task.id === 'string' && task.id ? task.id : `t${index + 1}`,
          title: task.title.trim().slice(0, 200),
          estimate: clampInt(task.estimate, 1, 50, 1),
          spent: clampInt(task.spent, 0, 200, 0),
          done: Boolean(task.done),
          notes: typeof task.notes === 'string' ? task.notes.slice(0, 500) : '',
        }))
      state.plan = {
        id: `plan-${now()}`,
        title: typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : '当前计划',
        createdAt: now(),
        tasks: normalized,
      }
      if (!state.plan.tasks.some((task) => task.id === state.taskId)) {
        state.taskId = normalized.length > 0 ? normalized[0].id : null
      }
      emit('plan.set', { title: state.plan.title, tasks: normalized.length, totalEstimate: normalized.reduce((sum, task) => sum + task.estimate, 0), taskId: state.taskId }, source)
      return ok()
    },

    'plan.select'(payload, source) {
      if (!state.plan) return fail('no_plan')
      const task = state.plan.tasks.find((x) => x.id === payload?.taskId)
      if (!task) return fail('task_not_found')
      state.taskId = task.id
      emit('plan.select', { taskId: task.id, title: task.title }, source)
      return ok()
    },

    'plan.toggle'(payload, source) {
      if (!state.plan) return fail('no_plan')
      const task = state.plan.tasks.find((x) => x.id === payload?.taskId)
      if (!task) return fail('task_not_found')
      task.done = payload?.done === undefined ? !task.done : Boolean(payload.done)
      emit('plan.toggle', { taskId: task.id, done: task.done, title: task.title }, source)
      return ok()
    },

    'plan.clear'(payload, source) {
      state.plan = null
      state.taskId = null
      emit('plan.clear', {}, source)
      return ok()
    },

    'config.set'(payload, source) {
      const patch = payload?.patch ?? payload ?? {}
      const before = { ...config }
      if (patch.focusMin !== undefined) config.focusMin = clampInt(patch.focusMin, 1, 240, config.focusMin)
      if (patch.shortBreakMin !== undefined) config.shortBreakMin = clampInt(patch.shortBreakMin, 1, 240, config.shortBreakMin)
      if (patch.breakMin !== undefined) config.shortBreakMin = clampInt(patch.breakMin, 1, 240, config.shortBreakMin)
      if (patch.longBreakMin !== undefined) config.longBreakMin = clampInt(patch.longBreakMin, 1, 240, config.longBreakMin)
      if (patch.roundsPerCycle !== undefined) config.roundsPerCycle = clampInt(patch.roundsPerCycle, 1, 12, config.roundsPerCycle)
      if (patch.shortBreaksEnabled !== undefined) config.shortBreaksEnabled = Boolean(patch.shortBreaksEnabled)
      if (patch.longBreaksEnabled !== undefined) config.longBreaksEnabled = Boolean(patch.longBreaksEnabled)
      if (patch.autoBreak !== undefined) config.autoBreak = Boolean(patch.autoBreak)
      if (patch.autoNextFocus !== undefined) config.autoNextFocus = Boolean(patch.autoNextFocus)
      if (patch.notifyOnPhaseEnd !== undefined) config.notifyOnPhaseEnd = Boolean(patch.notifyOnPhaseEnd)
      if (patch.cueVolume !== undefined) config.cueVolume = clampNum(patch.cueVolume, 0, 1, config.cueVolume)
      if (patch.tickDuringWork !== undefined) config.tickDuringWork = Boolean(patch.tickDuringWork)
      if (patch.tickDuringBreak !== undefined) config.tickDuringBreak = Boolean(patch.tickDuringBreak)
      for (const key of ['flowDataDir', 'loopIconsDir', 'musicDir', 'cueDir']) {
        if (typeof patch[key] === 'string') config[key] = patch[key].slice(0, 500)
      }
      state.config = config
      // 未开始的阶段，新时长立即生效
      if (state.runState !== 'running' && state.startedAt === null && state.phase !== 'idle') {
        state.plannedSec = phaseSeconds(state.phase)
        state.remainingSec = state.plannedSec
      }
      emit('config.set', { before, after: { ...config } }, source)
      return ok()
    },

    /**
     * 背景音：多路 FlowTunes 环境音（用户自己挑）+ 音乐（频道/本地）。
     * 一次调用可以只改一部分（patch 语义）。
     */
    'noise.set'(payload, source) {
      const patch = payload ?? {}
      const noise = state.noise
      if (patch.on !== undefined) noise.on = Boolean(patch.on)
      if (patch.master !== undefined) noise.master = clampNum(patch.master, 0, 1, noise.master)
      if (patch.ambientRatio !== undefined) noise.ambientRatio = clampNum(patch.ambientRatio, 0, 1, noise.ambientRatio)

      // 合成噪音（白/棕/雨）整块移除（2026-10-02，用户：只要 FlowTunes 的环境音，自己挑）。
      // patch.synth 现在被静默忽略——外部若还发这个字段不会报错，也不会生效。

      if (patch.loops !== undefined) {
        const loops = normalizeLoops(patch.loops)
        if (loops === null) return fail('bad_loops')
        noise.loops = loops
      }
      if (patch.addLoop !== undefined) {
        // 兼容两种形状：`addLoop: "rain"`（浮层发的简写）与 `addLoop: { id, volume }`（规范形状）。
        // 只认一种会让另一端静默失败——2026-10-02 实测踩到：浮层点「添加」报 bad_loop_id。
        const raw = typeof patch.addLoop === 'string' ? { id: patch.addLoop } : (patch.addLoop ?? {})
        const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 64) : ''
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) return fail('bad_loop_id')
        if (!noise.loops.some((x) => x.id === id)) {
          if (noise.loops.length >= MAX_LOOPS) return fail('too_many_loops')
          noise.loops.push({ id, volume: clampNum(raw.volume, 0, 1, 0.375) })
        }
      }
      if (patch.removeLoop !== undefined) {
        noise.loops = noise.loops.filter((x) => x.id !== patch.removeLoop)
      }
      if (patch.setLoopVolume !== undefined) {
        const target = noise.loops.find((x) => x.id === patch.setLoopVolume?.id)
        if (target) target.volume = clampNum(patch.setLoopVolume?.volume, 0, 1, target.volume)
      }
      if (patch.clearLoops) noise.loops = []

      if (patch.music !== undefined) {
        const m = patch.music ?? {}
        if (m.on !== undefined) noise.music.on = Boolean(m.on)
        if (m.channelId !== undefined) {
          const id = m.channelId === null ? null : String(m.channelId).slice(0, 128)
          if (id !== noise.music.channelId) noise.music.trackIndex = 0
          noise.music.channelId = id
        }
        if (m.trackIndex !== undefined) noise.music.trackIndex = clampInt(m.trackIndex, 0, 9999, noise.music.trackIndex)
        if (m.volume !== undefined) noise.music.volume = clampNum(m.volume, 0, 1, noise.music.volume)
      }

      emit('noise.set', {
        on: noise.on,
        master: noise.master,
        ambientRatio: noise.ambientRatio,
        loops: noise.loops.map((x) => x.id),
        music: noise.music.on ? noise.music.channelId : null,
      }, source)
      return ok()
    },

    'session.bind'(payload, source) {
      const id = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : null
      if (id === state.watchSessionId) return ok()
      state.watchSessionId = id
      emit('session.bind', { sessionId: id }, source)
      return ok()
    },

    /**
     * 指定/解除「管家会话」——只有它的 AI 看得见番茄钟工具。
     * 由人类命令 `/番茄钟 接管`（传当前会话 id）或 `/番茄钟 释放`（传 null）触发。
     */
    'manager.set'(payload, source) {
      const raw = payload?.sessionId
      const id = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 128) : null
      if (id === state.managerSessionId) return ok()
      state.managerSessionId = id
      // 管家即提醒接收者：提醒投递给管家会话（比"最后调用者"更符合语义）
      if (id) state.watchSessionId = id
      emit('manager.set', { sessionId: id }, source)
      return ok()
    },
  }

  function fail(code) {
    return { ok: false, error: code, snapshot: snapshot() }
  }

  function ok() {
    writeState()
    return { ok: true, snapshot: snapshot() }
  }

  function snapshot() {
    const task = currentTask()
    const totalEstimate = state.plan ? state.plan.tasks.reduce((sum, x) => sum + (x.estimate ?? 0), 0) : 0
    const totalSpent = state.plan ? state.plan.tasks.reduce((sum, x) => sum + (x.spent ?? 0), 0) : 0
    const stats = statsSnapshot()
    const nextRoundHint =
      state.phase === 'work' && state.workRoundNumber >= config.roundsPerCycle && config.longBreaksEnabled
        ? 'long-break'
        : null
    return {
      ok: true,
      now: now(),
      phase: state.phase,
      runState: state.runState,
      taskId: state.taskId,
      taskTitle: task ? task.title : null,
      // 轮次
      workRoundNumber: state.workRoundNumber,
      roundsPerCycle: config.roundsPerCycle,
      completedWorkRounds: state.completedWorkRounds,
      sessionWorkCount: state.sessionWorkCount,
      nextRoundHint,
      plannedSec: state.plannedSec,
      remainingSec: remainingSec(),
      startedAt: state.startedAt,
      deadlineAt: state.deadlineAt,
      pausedAt: state.pausedAt,
      pausedTotalSec: Math.round(state.pausedTotalSec),
      elapsedSec: elapsedOf(),
      plan: state.plan,
      planProgress: state.plan ? { totalEstimate, totalSpent } : null,
      config: { ...config },
      noise: {
        on: state.noise.on,
        master: state.noise.master,
        ambientRatio: state.noise.ambientRatio,
        loops: state.noise.loops.map((x) => ({ ...x })),
        music: { ...state.noise.music },
      },
      watch: { sessionId: state.watchSessionId },
      /** 管家会话：工具只注册进它的 scope；提醒也投递给它（回退到 watch）。 */
      manager: { sessionId: state.managerSessionId },
      reminderTarget: state.managerSessionId ?? state.watchSessionId,
      // stats.today 保持 v1 的扁平字段名（浮层与工具都在用）
      stats: stats.today,
      week: stats.week,
      lastEvent: events.length > 0 ? events[events.length - 1] : null,
    }
  }

  /** 到点结算。返回本次 tick 是否推进了阶段。 */
  function tick() {
    if (state.runState !== 'running' || !state.deadlineAt) return false
    if (now() < state.deadlineAt) return false
    settleCompletedPhase('system', false)
    writeState()
    return true
  }

  function command(action, payload, source) {
    const handler = commands[action]
    if (!handler) return { ok: false, error: 'unknown_action', action, snapshot: snapshot() }
    try {
      return handler(payload ?? {}, source ?? 'system')
    } catch (error) {
      return { ok: false, error: 'command_failed', message: String(error), snapshot: snapshot() }
    }
  }

  function recentEvents(limit = 50) {
    const n = clampInt(limit, 1, 500, 50)
    return events.slice(-n)
  }

  /** 本周（含今日）逐日统计，供浮层柱状图与工具使用。 */
  function weekStats() {
    return statsSnapshot().week
  }

  const offline = settleOffline()

  return {
    dir,
    stateFile,
    eventsFile,
    snapshot,
    command,
    tick,
    recentEvents,
    weekStats,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 测试/诊断用：直接读内部状态（只读副本）。 */
    raw: () => JSON.parse(JSON.stringify(state)),
    /** 状态文件读取失败的原因（正常为 null）——否则编程错误会被 catch 静默吞掉。 */
    loadError,
    offlineSettle: offline,
  }
}
