/**
 * client 半的回归测试——**在 node 里模拟 __ModuleLoader__ 与 React**，把浮层真渲染一遍。
 *
 *   node tools/client-check.mjs
 *
 * 为什么值得写：client 代码出错在浏览器里是「白屏/不挂载」，而官方装配下要重启 DSH 才生效。
 * 这里用最小 React 桩（createElement/useState/useEffect/useRef/useCallback）把组件跑起来，
 * 断言渲染出来的文本，能在重启前抓到崩溃与文案回归。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const code = readFileSync(CLIENT, 'utf8')

const checks = []
const check = (name, cond, extra) => checks.push({ name, pass: Boolean(cond), extra: cond ? undefined : extra })
const section = (t) => checks.push({ section: t })

// ═══ 静态检查：包装形制与预检正则 ═══════════════════════════════════════════
section('bundle 形制')
check('含 __ModuleLoader__.load 包装', code.includes('window.__ModuleLoader__.load('))
check('id 等于包名', /id:\s*"@dsh-external\/dsh-pomodoro-ai"/.test(code))
check('声明 inject = ["slots"]', /inject\s*=\s*\[[^\]]*['"]slots['"]/.test(code))
check(
  'register( 与 { 紧邻且 slot 名是字面量',
  /register\(\{[\s\S]{0,400}?name:\s*['"]shell\.overlay['"]/.test(code),
)
check('只 require react（不引第三方包）', [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].every((m) => m[1] === 'react'), [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))
// 与内核的契约：addLoop 必须是对象形状（曾发字符串 → 内核报 bad_loop_id，2026-10-02 实测）
check('client 发 addLoop 用对象形状（与内核契约一致）', /addLoop:\s*\{\s*id:/.test(code), (code.match(/addLoop:[^,}]*/g) || []).slice(0, 3))
check('client 不再把 addLoop 直接发字符串', !/addLoop:\s*[a-zA-Z_$][\w$.]*\s*[,}]/.test(code), (code.match(/addLoop:[^,}]*/g) || []).slice(0, 3))

// ═══ 在 node 里执行 bundle ═════════════════════════════════════════════════
section('加载与挂载')
const captured = {}
/** Node 里有些全局是只读的（如 navigator），统一用 defineProperty 覆盖。 */
const defineGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  } catch (e) {
    /* 覆盖不了就跳过：客户端代码不依赖它就没事 */
  }
}
/** 收集 window.addEventListener 的监听器，便于测试 pagehide 这类生命周期钩子。 */
const winListeners = {}
const fakeWindow = {
  __ModuleLoader__: { load: (def) => { captured.def = def } },
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener: (ev, cb) => {
    ;(winListeners[ev] ||= []).push(cb)
  },
  removeEventListener: () => {},
}
defineGlobal('window', fakeWindow)
defineGlobal('localStorage', { getItem: () => null, setItem: () => {} })
defineGlobal('document', { createElement: () => ({ style: {} }), querySelector: () => null, body: null, documentElement: null })
defineGlobal('location', { href: 'dsh-app://app/' })
defineGlobal('navigator', { userAgent: 'node-client-check' })
defineGlobal('fetch', async () => ({ json: async () => ({ ok: true }) }))
defineGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
/** 假的 <audio>：只记录被调用过的动作，用于断言"孤儿回收"确实发生。 */
const audioNodes = []
defineGlobal(
  'Audio',
  class FakeAudio {
    constructor(src) {
      this.src = src ?? ''
      this.paused = true
      this.volume = 1
      this.loop = false
      this.calls = []
      audioNodes.push(this)
    }
    play() {
      this.paused = false
      this.calls.push('play')
      return Promise.resolve()
    }
    pause() {
      this.paused = true
      this.calls.push('pause')
    }
    load() {
      this.calls.push('load')
    }
    removeAttribute(name) {
      this.calls.push('removeAttribute:' + name)
      if (name === 'src') this.src = ''
    }
    addEventListener() {}
  },
)

let execErr = null
try {
  // eslint-disable-next-line no-new-func
  new Function(code)()
} catch (e) {
  execErr = String(e)
}
check('bundle 可执行且注册进 ModuleLoader', !execErr && captured.def && typeof captured.def.factory === 'function', execErr)
check('bundle id 正确', captured.def?.id === '@dsh-external/dsh-pomodoro-ai', captured.def?.id)

const requireStub = (name) => {
  if (name !== 'react') throw new Error('unexpected require: ' + name)
  return reactStub
}

// 最小 React 桩：useState 按调用顺序从队列取值，于是能把「有快照」这一帧渲染出来
let reactStub = null
let stateQueue = []
function makeReact() {
  return {
    // 展开函数组件：不展开的话，组件内部用到的 props（如 PanelTitle 的 extra）
    // 在文本收集里就是不可见的——测试会给出假阴性。
    createElement: (type, props, ...children) => {
      const p = { ...(props || {}), children: children.flat(Infinity) }
      if (typeof type === "function") return type(p)
      return { type, props: p }
    },
    useState: () => [stateQueue.shift(), () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  }
}
reactStub = makeReact()

let mod = null
let factoryErr = null
try {
  mod = captured.def.factory(requireStub)
} catch (e) {
  factoryErr = String(e)
}
check('factory 返回 exports', !factoryErr && mod && typeof mod === 'object', factoryErr)
check('exports.inject 含 slots', Array.isArray(mod?.inject) && mod.inject.includes('slots'), mod?.inject)
check('exports.apply 是函数', typeof mod?.apply === 'function', typeof mod?.apply)

let registered = null
let mountErr = null
try {
  mod.apply({
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    slots: {
      inject: (_slot, cb) => cb(),
      register: (reg, Comp) => {
        registered = { reg, Comp }
        return () => {}
      },
    },
  })
} catch (e) {
  mountErr = String(e)
}
check('apply 无异常', !mountErr, mountErr)
check('注册到 shell.overlay', registered?.reg?.name === 'shell.overlay', registered?.reg?.name)
check('注册 id = pomodoro-ai.widget', registered?.reg?.id === 'pomodoro-ai.widget', registered?.reg?.id)
check('注册 order 为数字', typeof registered?.reg?.order === 'number', registered?.reg?.order)
check('label 可调用', typeof registered?.reg?.label === 'function' && typeof registered.reg.label() === 'string', null)
check('组件是函数', typeof registered?.Comp === 'function', typeof registered?.Comp)

// ═══ 渲染 ═══════════════════════════════════════════════════════════════════
section('渲染')
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
  return out
}
const renderText = (queue) => {
  stateQueue = queue.slice()
  reactStub = makeReact()
  const tree = registered.Comp()
  return { tree, text: collectText(tree).join(' | ') }
}

// 第一帧：还没有快照 → 连接中
let out = renderText([null, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, null, false, false, "auto"])
check('无快照时显示连接中', out.text.includes('番茄钟连接中'), out.text)

const SNAP = {
  ok: true,
  now: 1_700_000_000_000,
  phase: 'work',
  runState: 'running',
  taskId: 't1',
  taskTitle: '写周报',
  workRoundNumber: 3,
  roundsPerCycle: 4,
  completedWorkRounds: 2,
  sessionWorkCount: 3,
  nextRoundHint: 'long-break',
  plannedSec: 1500,
  remainingSec: 900,
  startedAt: 1_700_000_000_000,
  deadlineAt: 1_700_000_900_000,
  pausedAt: null,
  pausedTotalSec: 0,
  elapsedSec: 600,
  plan: { id: 'p1', title: '写周报', createdAt: 1, tasks: [{ id: 't1', title: '收集数据', estimate: 2, spent: 1, done: false, notes: '' }, { id: 't2', title: '成稿', estimate: 1, spent: 0, done: false, notes: '' }] },
  planProgress: { totalEstimate: 3, totalSpent: 1 },
  config: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerCycle: 4, autoBreak: true, autoNextFocus: false, notifyOnPhaseEnd: true, cueVolume: 0.7, tickDuringWork: false, tickDuringBreak: false },
  noise: { on: true, master: 0.5, ambientRatio: 1, loops: [{ id: 'rain', volume: 0.3 }], music: { on: true, channelId: 'ch-1', trackIndex: 0, volume: 0.6 } },
  watch: { sessionId: 'session-x' },
  stats: { todayFocusCount: 3, todayFocusSec: 4500, todayPauseCount: 1, todayOfflineCount: 0 },
  week: {
    days: [
      { day: '2026-09-26', focusCount: 0, focusSec: 0, pauseCount: 0, offlineCount: 0, rounds: 0 },
      { day: '2026-09-27', focusCount: 2, focusSec: 3000, pauseCount: 0, offlineCount: 0, rounds: 0 },
      { day: '2026-09-28', focusCount: 4, focusSec: 6000, pauseCount: 1, offlineCount: 0, rounds: 0 },
      { day: '2026-09-29', focusCount: 1, focusSec: 1500, pauseCount: 0, offlineCount: 0, rounds: 0 },
      { day: '2026-09-30', focusCount: 0, focusSec: 0, pauseCount: 0, offlineCount: 0, rounds: 0 },
      { day: '2026-10-01', focusCount: 5, focusSec: 7500, pauseCount: 0, offlineCount: 0, rounds: 0 },
      { day: '2026-10-02', focusCount: 3, focusSec: 4500, pauseCount: 1, offlineCount: 0, rounds: 0 },
    ],
    totals: { focusCount: 15, focusSec: 22500, pauseCount: 2, offlineCount: 0 },
    dayCount: 7,
  },
  lastEvent: { t: 1_700_000_000_000, type: 'phase.start', source: 'ai', phase: 'work' },
}
const FLOW = {
  ok: true,
  audioBase: 'https://example.supabase.co/storage/v1/object/public',
  trackUrlTemplate: 'https://example/track-audio-v3/mds/{id}.m4a',
  loopUrlTemplate: 'https://example/loop-audio-v3/{id}.m4a',
  channels: [{ id: 'ch-1', slug: 'lofi', title: 'Lo-Fi 学习', subtitle: '', cover: '' }],
  catalog: { tracks: { 'ch-1': ['t1', 't2'] } },
  ambient: { sounds: [{ id: 'rain', title: 'Spring Showers', description: '' }, { id: 'fire-campfire', title: 'Campfire', description: '' }], categories: [] },
  local: { tracks: [{ name: 'song.mp3', url: '/pomodoro-ai/api/audio/song.mp3' }], channelId: 'local' },
  missing: [],
}

out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, "auto"])
check('显示倒计时', /\d\d:\d\d/.test(out.text), out.text.slice(0, 120))
check('显示阶段标签', out.text.includes('专注'), null)
check('显示轮次 x/N', out.text.includes('第 3/4 个番茄'), null)
check('提示下一个是长休', out.text.includes('下一个是长休'), null)
check('显示当前任务', out.text.includes('写周报'), null)
check('显示计划进度 1/3', out.text.includes('计划 1/3'), null)
check('显示计划任务行', out.text.includes('收集数据') && out.text.includes('成稿'), null)
check('显示今日统计', out.text.includes('今日 3 个') && out.text.includes('75 分钟'), null)
check('暂停按钮存在', out.text.includes('暂停'), null)
check('显示声音面板标题', out.text.includes('声音'), null)

// 打开声音面板
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"])
check('声音面板：合成噪音行已移除', !out.text.includes('棕噪') && !out.text.includes('白噪') && !out.text.includes('合成'), null)
check('声音面板：保留总开关与总音量', out.text.includes('总开关') && out.text.includes('总音量'), null)
check('声音面板：已选环境音带音量', out.text.includes('rain ×0.30'), null)
check('声音面板：音乐频道下拉', out.text.includes('Lo-Fi 学习') && out.text.includes('本地文件夹（1）'), null)
check('周统计面板渲染标题与合计', out.text.includes('近 7 天') && out.text.includes('共 15 个'), out.text.slice(0, 400))

// 打开环境音选择器
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: true, week: false }, FLOW, true, false, "auto"])
check('声音面板：选择器列出可用音源', out.text.includes('Spring Showers') && out.text.includes('Campfire'), out.text.slice(0, 400))

// 迷你模式：用户要求「只有一个圈 + 中间的数字，点一下展开」
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"])
let miniTree = null
const miniOut = (() => {
  stateQueue = [SNAP, null, 0, true, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"]
  reactStub = makeReact()
  miniTree = registered.Comp()
  return collectText(miniTree).join(' | ')
})()
check('迷你态显示倒计时数字', /\d\d:\d\d/.test(miniOut), miniOut.slice(0, 80))
check('迷你态不含阶段文字（专注/短休/长休）', !/专注|短休|长休/.test(miniOut), miniOut.slice(0, 80))
check('迷你态不含轮次文字', !miniOut.includes('第 3/4') && !miniOut.includes('番茄'), miniOut.slice(0, 80))
check('迷你态不含任务名与计划', !miniOut.includes('写周报') && !miniOut.includes('计划'), miniOut.slice(0, 80))
check('迷你态不含任何按钮', !/暂停|继续|跳过|重置|停止|迷你|展开|配色/.test(miniOut), miniOut.slice(0, 120))
check('迷你态隐藏全部面板与页脚', !miniOut.includes('近 7 天') && !miniOut.includes('Spring Showers') && !miniOut.includes('今日'), miniOut.slice(0, 120))
check('迷你态只有圆圈 + 数字 + 一行小字', (() => {
  const texts = collectText(miniTree).filter((t) => String(t).trim()).map((t) => String(t).trim())
  return texts.length === 2 && /^\d\d:\d\d$/.test(texts[0]) && /^(focus|relax|ready)$/.test(texts[1])
})(), collectText(miniTree))
// 形状由 SVG 几何保证，不依赖 CSS（borderRadius:50% 实测被渲染成圆角方形）
/** 按元素类型收集（collectStyled 只收带 style 的，SVG 圆底没有 style 属性）。 */
function collectByType(node, type, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const c of node) collectByType(c, type, out)
    return out
  }
  if (node.props) {
    if (node.type === type) out.push(node)
    collectByType(node.props.children, type, out)
  }
  return out
}
check('迷你态圆底是 SVG 实心圆（不靠 CSS 圆角）', (() => {
  const circles = collectByType(miniTree, 'circle')
  const bg = circles[0]
  return (
    circles.length === 3 &&
    Boolean(bg) &&
    typeof bg.props.fill === 'string' &&
    bg.props.fill !== 'none' &&
    bg.props.strokeDasharray === undefined &&
    bg.props.r === 41 - 0.5
  )
})(), collectByType(miniTree, 'circle').map((c) => ({ fill: c.props.fill, r: c.props.r })))
check('迷你态容器不再设 border-radius/背景（避免方形阴影）', (() => {
  const wrap = collectStyled(miniTree).find((el) => typeof el.props?.style?.filter === 'string' && el.props.style.filter.includes('drop-shadow'))
  return Boolean(wrap) && wrap.props.style.borderRadius === undefined && wrap.props.style.background === undefined && wrap.props.style.boxShadow === undefined
})(), null)

// 数字下方的小字：focus / relax（用户要求一眼看出专注还是休息）
const miniLabelFor = (snap) => {
  stateQueue = [snap, null, 0, true, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"]
  reactStub = makeReact()
  const texts = collectText(registered.Comp()).filter((t) => String(t).trim()).map((t) => String(t).trim())
  return texts[1]
}
const liveSnap = { ...SNAP, deadlineAt: Date.now() + 600_000 }
check('专注阶段显示 focus', miniLabelFor({ ...liveSnap, phase: 'work' }) === 'focus', miniLabelFor({ ...liveSnap, phase: 'work' }))
check('短休显示 relax', miniLabelFor({ ...liveSnap, phase: 'short-break' }) === 'relax', miniLabelFor({ ...liveSnap, phase: 'short-break' }))
check('长休显示 relax', miniLabelFor({ ...liveSnap, phase: 'long-break' }) === 'relax', miniLabelFor({ ...liveSnap, phase: 'long-break' }))
check('待开始显示 ready', miniLabelFor({ ...liveSnap, phase: 'idle', runState: 'idle' }) === 'ready', miniLabelFor({ ...liveSnap, phase: 'idle', runState: 'idle' }))
check('小字用阶段色（与圆环同色系）', (() => {
  stateQueue = [{ ...liveSnap, phase: 'work' }, null, 0, true, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"]
  reactStub = makeReact()
  const tree = registered.Comp()
  const label = collectStyled(tree).find((el) => collectText(el).join('').trim() === 'focus')
  return Boolean(label) && typeof label.props.style.color === 'string' && label.props.style.color.length > 0
})(), null)
check('迷你态有展开提示（title 里带阶段与点击说明）', (() => {
  const withTitle = collectStyled(miniTree).find((el) => typeof el.props?.title === 'string' && el.props.title.includes('点击展开'))
  return Boolean(withTitle)
})(), null)
check('迷你态圆环按剩余比例绘制（会随时间缩短）', (() => {
  // 用相对当前时间的快照：夹具里那个固定 deadlineAt 早已过期（环当然是空的）
  const live = { ...SNAP, deadlineAt: Date.now() + 900_000, plannedSec: 1500 }
  stateQueue = [live, null, 0, true, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"]
  reactStub = makeReact()
  const tree = registered.Comp()
  const circles = collectStyled(tree).filter((el) => el.type === 'circle' && el.props?.strokeDashoffset !== undefined)
  const c = circles[circles.length - 1]
  if (!c) return false
  const total = Number(c.props.strokeDasharray)
  const offset = Number(c.props.strokeDashoffset)
  // 剩 900/1500 → 弧长约 60%，被"烧掉"的部分约 40%
  return Math.abs(offset / total - 0.4) < 0.02
})(), null)
check('剩余时间越多弧越长（单调性）', (() => {
  const arcAt = (msLeft) => {
    const live = { ...SNAP, deadlineAt: Date.now() + msLeft, plannedSec: 1500 }
    stateQueue = [live, null, 0, true, { right: 18, bottom: 18 }, { plan: true, sound: true, week: true }, FLOW, false, false, "auto"]
    reactStub = makeReact()
    const circles = collectStyled(registered.Comp()).filter((el) => el.type === 'circle' && el.props?.strokeDashoffset !== undefined)
    const c = circles[circles.length - 1]
    return Number(c.props.strokeDasharray) - Number(c.props.strokeDashoffset)
  }
  const a = arcAt(1_200_000)
  const b = arcAt(600_000)
  const c2 = arcAt(60_000)
  return a > b && b > c2
})(), null)

// 长休阶段
const longBreakSnap = { ...SNAP, phase: 'long-break', nextRoundHint: null, workRoundNumber: 4 }
out = renderText([longBreakSnap, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, "auto"])
check('长休阶段标签正确', out.text.includes('长休'), null)

// 缺数据文件时的降级
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: true, week: false }, { ...FLOW, ambient: { sounds: [], categories: [] }, missing: ['channels.json'] }, true, false, "auto"])
check('缺数据文件时给出提示而非崩溃', out.text.includes('缺数据文件'), out.text.slice(0, 160))

// ═══ 配色对比度（回归：白底白字事故）════════════════════════════════════════
section('配色对比度')
/** 收集所有带 style 的元素，方便按文本找按钮。 */
function collectStyled(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const c of node) collectStyled(c, out)
    return out
  }
  if (node.props) {
    if (node.props.style) out.push(node)
    collectStyled(node.props.children, out)
  }
  return out
}
const styledFor = (queue) => {
  stateQueue = queue.slice()
  reactStub = makeReact()
  const tree = registered.Comp()
  // 主按钮的独有标记：border 是 "1px solid transparent"（见 Btn 实现）
  return collectStyled(tree).filter((el) => el.type === 'button' && el.props?.style?.border === '1px solid transparent')
}
for (const scheme of ['auto', 'ink', 'slate', 'paper']) {
  const queue = [SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, scheme]
  const btn = styledFor(queue)[0]
  const fg = btn?.props?.style?.color
  const bg = btn?.props?.style?.background
  check(`[${scheme}] 主按钮文字色与底色都非空且不同`, Boolean(fg) && Boolean(bg) && fg !== bg, [fg, bg])
  check(`[${scheme}] 主按钮不使用主题 token（自带调色板）`, typeof bg === 'string' && !String(bg).includes('var('), bg)
}
// 三个方案的主按钮颜色必须两两不同（说明切换真的生效）
const primaryColors = ['ink', 'slate', 'paper'].map((s) => styledFor([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, s])[0]?.props?.style?.background)
check('三种配色方案的主按钮底色各不相同', new Set(primaryColors).size === 3, primaryColors)
// 深色/浅色/墨白三种方案的正文色也都不是 token
const textColors = ['ink', 'slate', 'paper'].map((s) => {
  stateQueue = [SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, s]
  reactStub = makeReact()
  const tree = registered.Comp()
  return collectStyled(tree).find((el) => String(collectText(el).join('')).includes('番茄钟') && el.props?.style?.color)?.props?.style?.color
})
check('正文色自带而非 token', textColors.every((c) => typeof c === 'string' && !c.includes('var(')), textColors)
check('墨白方案正文为纯黑、深色方案正文为浅色', textColors[0] === '#000000' && textColors[1] === '#f5f7fb', textColors)
// 配色切换按钮存在
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, 'auto'])
check('头部有配色切换按钮', out.text.includes('配色·自动'), null)
out = renderText([SNAP, null, 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, FLOW, false, false, 'ink'])
check('配色按钮显示当前方案名', out.text.includes('配色·墨白'), null)

// 错误态
out = renderText([SNAP, 'state 响应异常', 0, false, { right: 18, bottom: 18 }, { plan: true, sound: false, week: false }, null, false, false, "auto"])
check('错误信息会显示出来', out.text.includes('state 响应异常'), null)

// ═══ 孤儿音频回收（回归：热重载后旧噪音停不掉的事故）═══════════════════════
section('孤儿音频回收')
const KEY = '__dshPomodoroAudioRegistry'
const reg1 = fakeWindow[KEY]
check('载入后注册了发声节点注册表', Boolean(reg1) && typeof reg1.panic === 'function', typeof reg1)
check('注册了 pagehide / beforeunload 兜底', Array.isArray(winListeners.pagehide) && winListeners.pagehide.length > 0 && winListeners.beforeunload.length > 0, Object.keys(winListeners))
check('合成噪音相关的 Web Audio 机制已彻底移除', !/new\s+(window\.)?(webkit)?AudioContext/.test(code) && !/createBufferSource|createGain|createBiquadFilter|createBuffer\(/.test(code), (code.match(/createBufferSource|createGain|createBuffer\(|new AudioContext/g) || []).slice(0, 3))

// 造两个"正在响"的节点，然后模拟热重载（再次执行 bundle）
const nodeA = new globalThis.Audio('loop.m4a')
const nodeB = new globalThis.Audio('track.m4a')
nodeA.play()
nodeB.play()
reg1.add(nodeA)
reg1.add(nodeB)
check('注册表登记了发声节点', reg1.nodes.size === 2, reg1.nodes.size)

const panicSpy = { count: 0 }
const realPanic = reg1.panic.bind(reg1)
reg1.panic = () => {
  panicSpy.count += 1
  realPanic()
}
// eslint-disable-next-line no-new-func
new Function(code)() // 重新注册 bundle（HMR 第一步）
captured.def.factory(requireStub) // HMR 第二步：实例化新模块——回收就该发生在这里
check('再次载入 bundle 会先回收上一版的音频节点', panicSpy.count === 1, panicSpy.count)
check('旧节点被停掉并释放 src', nodeA.paused === true && nodeA.src === '' && nodeB.paused === true, [nodeA.paused, nodeA.src, nodeB.paused])
check('回收后旧注册表清空', reg1.nodes.size === 0, reg1.nodes.size)
const reg2 = fakeWindow[KEY]
check('新 bundle 装上了自己的注册表（与旧的不是同一个）', Boolean(reg2) && reg2 !== reg1, null)

// pagehide 兜底
const nodeC = new globalThis.Audio('loop2.m4a')
nodeC.play()
reg2.add(nodeC)
for (const cb of winListeners.pagehide) cb()
check('pagehide 时停掉所有发声节点', nodeC.paused === true && reg2.nodes.size === 0, [nodeC.paused, reg2.nodes.size])

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
