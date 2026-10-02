/**
 * host 半的回归测试——**脱离 DSH**，直接用 node 跑工具与路由。
 *
 *   node tools/host-smoke.mjs
 *
 * 为什么值得写：官方装配下改 host 代码必须重启 DSH 才生效，
 * 所以「重启前就能验证」的测试价值极高（这是被重复装配事故教出来的）。
 *
 * 覆盖：5 个工具（schema 合法性 + execute 输出）、全部 HTTP 路由、
 * Range 请求（音频拖动进度条）、路径穿越防护、错误分支。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { createStore } from '../lib/store.js'
import { assertToolSchema, createTools, createApiHandler, createFlowLoader } from '../lib/index.js'

const ROOT = join(tmpdir(), 'pomodoro-ai-host-smoke')
rmSync(ROOT, { recursive: true, force: true })

const checks = []
const check = (name, cond, extra) => checks.push({ name, pass: Boolean(cond), extra: cond ? undefined : extra })
const section = (t) => checks.push({ section: t })

// ── 夹具 ───────────────────────────────────────────────────────────────────
const FIX = join(ROOT, 'fixtures')
const DIRS = {
  flowDataDir: join(FIX, 'flowtunes'),
  loopIconsDir: join(FIX, 'loop-icons'),
  cueDir: join(FIX, 'audio'),
  musicDir: join(FIX, 'music'),
}
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true })
writeFileSync(join(DIRS.flowDataDir, 'channels.json'), JSON.stringify([{ id: 'ch-1', slug: 'lofi', title: 'Lo-Fi', subtitle: '', cover: '' }]))
writeFileSync(join(DIRS.flowDataDir, 'catalog.json'), JSON.stringify({ tracks: { 'ch-1': ['t1', 't2'] } }))
writeFileSync(
  join(DIRS.flowDataDir, 'ambient.json'),
  JSON.stringify({ sounds: [{ id: 'rain', title: 'Spring Showers', description: '' }, { id: 'fire-campfire', title: 'Campfire', description: '' }], categories: [{ id: 'water', title: 'Water', description: '', loopIds: ['rain'] }] }),
)
writeFileSync(join(DIRS.loopIconsDir, 'rain.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
writeFileSync(join(DIRS.cueDir, 'alert-work.mp3'), Buffer.from('ID3fake-mp3-bytes-0123456789'))
writeFileSync(join(DIRS.musicDir, 'song.mp3'), Buffer.from('ID3local-song-bytes-abcdefghij'))
writeFileSync(join(DIRS.musicDir, 'notes.txt'), 'not audio')

const store = createStore({ dir: join(ROOT, 'state'), config: DIRS, now: () => 1_700_000_000_000 })
const records = []
const record = (kind, data) => records.push({ kind, ...data })
const paths = () => ({ ...DIRS })
const loadFlowData = createFlowLoader(paths)
const resolveSessionId = () => store.snapshot().watch.sessionId

// ── 假 req/res ─────────────────────────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const handlers = {}
  const req = {
    method,
    url,
    headers,
    on(ev, cb) {
      ;(handlers[ev] ||= []).push(cb)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== null) for (const cb of handlers.data ?? []) cb(Buffer.from(body))
    for (const cb of handlers.end ?? []) cb()
  })
  return req
}

class FakeRes extends Writable {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = null
    this.chunks = []
  }
  writeHead(code, headers) {
    this.statusCode = code
    this.headers = headers
    return this
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  end(data) {
    if (data) this.chunks.push(Buffer.from(data))
    return super.end()
  }
  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
  get json() {
    return JSON.parse(this.text)
  }
}

const handler = createApiHandler({ store, record, paths, loadFlowData, getSchedule: () => null })
const call = async (opts) => {
  const req = fakeReq(opts)
  const res = new FakeRes()
  const done = new Promise((resolve) => res.on('finish', resolve))
  await handler(req, res)
  await done
  return res
}

// ═══ 工具 schema ═══════════════════════════════════════════════════════════
section('工具 schema（防「一个坏工具挂全站」）')
const MANAGER = 'session-manager'
const managerId = () => MANAGER
const tools = createTools({ store, resolveSessionId, loadFlowData, record, managerId })
check('共 5 个工具', tools.length === 5, tools.length)
let schemaOk = true
let schemaErr = null
for (const t of tools) {
  try {
    assertToolSchema(t)
  } catch (e) {
    schemaOk = false
    schemaErr = String(e)
  }
}
check('全部通过 assertToolSchema', schemaOk, schemaErr)
check('工具名唯一且带前缀', new Set(tools.map((t) => t.name)).size === tools.length && tools.every((t) => t.name.startsWith('pomodoro_')), tools.map((t) => t.name))
check('parameters 都是 object 且有 properties', tools.every((t) => t.parameters.type === 'object' && typeof t.parameters.properties === 'object'), null)
check('空 parameters 会被 assertToolSchema 拒绝', (() => {
  try {
    assertToolSchema({ name: 'x', parameters: {}, output: { schema: {}, render: () => [] }, execute() {} })
    return false
  } catch {
    return true
  }
})(), null)
check('缺 output.render 会被拒绝', (() => {
  try {
    assertToolSchema({ name: 'x', parameters: { type: 'object', properties: {} }, output: { schema: {} }, execute() {} })
    return false
  } catch {
    return true
  }
})(), null)

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
/** 默认以「管家会话」身份调用；测拒绝时显式传别的会话。 */
const run = (name, args, exec) => byName[name].execute(args ?? {}, exec ?? { agent: { id: MANAGER } })

// ═══ 管家会话隔离（第二道闸）═══════════════════════════════════════════════
section('管家会话隔离')
for (const name of ['pomodoro_plan', 'pomodoro_start', 'pomodoro_control', 'pomodoro_status', 'pomodoro_noise']) {
  const asOther = await byName[name].execute({ action: 'list', tasks: [{ title: 'x' }] }, { agent: { id: 'session-somebody-else' } })
  check(`${name} 对非管家会话拒绝`, typeof asOther === 'string' && asOther.includes('管家会话'), String(asOther).slice(0, 50))
}
const notSet = createTools({ store, resolveSessionId, loadFlowData, record, managerId: () => null })
const deniedAll = await Promise.all(notSet.map((t) => t.execute({}, { agent: { id: 'session-any' } })))
check('未指定管家时谁都用不了', deniedAll.every((r) => typeof r === 'string' && r.includes('管家会话')), deniedAll.length)
const notSetNoAgent = await notSet[3].execute({ events: 0 }, {})
check('无管家 + 无身份 → 仍拒绝', typeof notSetNoAgent === 'string' && notSetNoAgent.includes('管家会话'), String(notSetNoAgent).slice(0, 50))
// 身份缺失（替代派发路径，如 ptc）→ 放行：可见性那层已保证只有管家看得见它，
// 这里拒绝反而会在替代路径上把管家自己挡死（见 index.js 里的注释）
const noAgent = await byName.pomodoro_status.execute({ events: 0 }, {})
check('身份缺失时放行（交给可见性层把关）', typeof noAgent === 'string' && !noAgent.includes('不是管家'), String(noAgent).slice(0, 50))

// ═══ 工具行为 ═════════════════════════════════════════════════════════════
section('工具行为')
let out = await run('pomodoro_plan', { title: '写周报', tasks: [{ title: '收集数据', estimate: 2 }, { title: '成稿', estimate: 1 }] })
check('plan 返回计划摘要', out.includes('写周报') && out.includes('收集数据'), out.slice(0, 80))
out = await run('pomodoro_start', { focusMinutes: 1, shortBreakMinutes: 1 }, { agent: { id: MANAGER } })
check('start 绑定会话并启动', store.snapshot().watch.sessionId === MANAGER && store.snapshot().phase === 'work', store.snapshot().phase)
check('start 回复含轮次与通知说明', out.includes('第 1/4') && out.includes('通知'), out)
out = await run('pomodoro_control', { action: 'pause' })
check('pause 生效', store.snapshot().runState === 'paused', store.snapshot().runState)
out = await run('pomodoro_control', { action: 'config', roundsPerCycle: 3, longBreakMin: 20, tickDuringWork: true })
check('config 生效', store.snapshot().config.roundsPerCycle === 3 && store.snapshot().config.longBreakMin === 20, store.snapshot().config)
out = await run('pomodoro_control', { action: 'stop' })
check('stop 生效', store.snapshot().phase === 'idle', store.snapshot().phase)
out = await run('pomodoro_status', { events: 5 })
check('status 含轮次/今日/近 7 天', out.includes('轮次：第') && out.includes('今日：') && out.includes('近 7 天'), out.slice(0, 120))
out = await run('pomodoro_noise', { action: 'list' })
check('noise list 列出环境音与频道', out.includes('rain') && out.includes('ch-1') && out.includes('本地音乐文件夹另有 1 首'), out.slice(0, 200))
out = await run('pomodoro_noise', { action: 'set', on: true, addLoop: 'rain', loopVolume: 0.3, musicOn: true, channelId: 'ch-1' })
check('noise set 生效', (() => {
  const n = store.snapshot().noise
  return n.on && n.loops[0]?.id === 'rain' && n.loops[0]?.volume === 0.3 && n.music.channelId === 'ch-1'
})(), store.snapshot().noise)
out = await run('pomodoro_noise', { action: 'set', addLoop: '../etc' })
check('非法环境音 id 被拒（不崩）', out.includes('失败'), out)
check('工具 schema 里已无合成噪音参数', !('synthMode' in byName.pomodoro_noise.parameters.properties) && !('synthVolume' in byName.pomodoro_noise.parameters.properties), Object.keys(byName.pomodoro_noise.parameters.properties))
out = await run('pomodoro_control', { action: '不存在的动作' })
check('未知动作被拒（不崩）', out.includes('失败'), out)

// ═══ 路由 ═════════════════════════════════════════════════════════════════
section('HTTP 路由')
let res = await call({ url: '/pomodoro-ai/api/health' })
check('GET /health 200', res.statusCode === 200 && res.json.ok, [res.statusCode, res.text.slice(0, 80)])
check('/health 带 build 与轮次字段', typeof res.json.build === 'string' && res.json.roundsPerCycle === 3, res.json)
res = await call({ url: '/pomodoro-ai/api/state' })
check('GET /state 200 且 ok', res.statusCode === 200 && res.json.ok === true, res.statusCode)
res = await call({ method: 'POST', url: '/pomodoro-ai/api/command', body: JSON.stringify({ action: 'start', payload: { focusMinutes: 2 }, source: 'widget' }) })
check('POST /command 启动成功', res.statusCode === 200 && res.json.ok && res.json.snapshot.phase === 'work', res.json.snapshot?.phase)
check('command 的 source 被记录为 widget', store.recentEvents(5).some((e) => e.type === 'phase.start' && e.source === 'widget'), null)
res = await call({ url: '/pomodoro-ai/api/events?limit=3' })
check('GET /events 返回事件', res.statusCode === 200 && Array.isArray(res.json.events) && res.json.events.length === 3, res.json.events?.length)
res = await call({ method: 'POST', url: '/pomodoro-ai/api/command', body: '{bad json' })
check('坏 JSON → 400', res.statusCode === 400 && res.json.error === 'bad_json', res.statusCode)
res = await call({ method: 'GET', url: '/pomodoro-ai/api/command' })
check('GET /command → 405', res.statusCode === 405, res.statusCode)
res = await call({ url: '/pomodoro-ai/api/nope' })
check('未知路由 → 404', res.statusCode === 404 && res.json.error === 'not_found', res.statusCode)

section('FlowTunes 数据与静态资源')
res = await call({ url: '/pomodoro-ai/api/flow/data' })
check('flow/data 返回频道+目录+环境音', res.statusCode === 200 && res.json.channels.length === 1 && res.json.ambient.sounds.length === 2, res.json.channels?.length)
check('flow/data 带 URL 模板（音频走网络）', res.json.trackUrlTemplate.includes('track-audio-v3') && res.json.loopUrlTemplate.includes('loop-audio-v3'), res.json.trackUrlTemplate)
check('flow/data 列出本地音乐', res.json.local.tracks.length === 1 && res.json.local.tracks[0].name === 'song.mp3', res.json.local)
check('缺失文件会被标注', Array.isArray(res.json.missing) && res.json.missing.length === 0, res.json.missing)
res = await call({ url: '/pomodoro-ai/api/flow/icon/rain' })
check('GET /flow/icon/rain 返回 SVG', res.statusCode === 200 && res.headers['content-type'] === 'image/svg+xml' && res.text.includes('<svg'), res.statusCode)
res = await call({ url: '/pomodoro-ai/api/flow/icon/../secret' })
check('图标路径穿越被拒', res.statusCode === 400 || res.statusCode === 404, res.statusCode)

section('提示音与本地音乐（含 Range）')
res = await call({ url: '/pomodoro-ai/api/cue/alert-work' })
check('GET /cue/alert-work 200 + audio/mpeg', res.statusCode === 200 && res.headers['content-type'] === 'audio/mpeg', [res.statusCode, res.headers?.['content-type']])
check('cue 带 accept-ranges 与 content-length', res.headers['accept-ranges'] === 'bytes' && Number(res.headers['content-length']) === 28, res.headers)
res = await call({ url: '/pomodoro-ai/api/cue/nope' })
check('未知 cue → 404', res.statusCode === 404 && res.json.error === 'unknown_cue', res.statusCode)
res = await call({ url: '/pomodoro-ai/api/audio/song.mp3' })
check('本地音乐可播放', res.statusCode === 200 && res.text.includes('local-song'), res.statusCode)
res = await call({ url: '/pomodoro-ai/api/audio/notes.txt' })
check('非音频扩展名被拒', res.statusCode === 400 && res.json.error === 'bad_ext', res.statusCode)
res = await call({ url: '/pomodoro-ai/api/audio/song.mp3', headers: { range: 'bytes=4-13' } })
check('Range 请求 → 206 且只回片段', res.statusCode === 206 && res.text === 'ocal-song-', [res.statusCode, res.text])
check('Range 响应带 content-range', res.headers['content-range'] === 'bytes 4-13/30', res.headers['content-range'])
res = await call({ url: '/pomodoro-ai/api/audio/song.mp3', headers: { range: 'bytes=999-1200' } })
check('越界 Range → 416', res.statusCode === 416, res.statusCode)
res = await call({ url: '/pomodoro-ai/api/audio/../../etc/passwd' })
check('音频路径穿越被拒', res.statusCode === 400 || res.statusCode === 404, res.statusCode)

section('客户端探针')
res = await call({ method: 'POST', url: '/pomodoro-ai/api/probe', body: JSON.stringify({ stage: 'test' }) })
check('POST /probe 200', res.statusCode === 200 && res.json.stored === true, res.statusCode)
check('探针落进观测记录', records.some((r) => r.kind === 'client.probe' && r.stage === 'test'), records.map((r) => r.kind))

// ═══ 真实音源目录（elegant-pomodoro 的静态资源）═════════════════════════════
section('真实音源目录（本机）')
/** 真实音源目录（可选）：设 POMODORO_STATIC 指向你的 static 目录，这一节才会跑。 */
const REAL = process.env.POMODORO_STATIC || ''
const REAL_DIRS = {
  flowDataDir: join(REAL, 'flowtunes'),
  loopIconsDir: join(REAL, 'loop-icons'),
  cueDir: join(REAL, 'audio'),
  musicDir: DIRS.musicDir,
}
if (!existsSync(REAL)) {
  check('（跳过：本机没有 elegant-pomodoro 静态目录）', true, null)
} else {
  const realStore = createStore({ dir: join(ROOT, 'real-state'), config: REAL_DIRS, now: () => 1_700_000_000_000 })
  const realFlow = await createFlowLoader(() => REAL_DIRS)()
  check('FlowTunes 数据文件齐全', realFlow.missing.length === 0, realFlow.missing)
  check('频道数 > 0', realFlow.channels.length > 0, realFlow.channels.length)
  check('环境音数量 > 50', realFlow.ambient.sounds.length > 50, realFlow.ambient.sounds.length)
  check('环境音分类存在', realFlow.ambient.categories.length > 0, realFlow.ambient.categories.length)
  check('曲目目录非空', Object.keys(realFlow.catalog.tracks ?? {}).length > 0, Object.keys(realFlow.catalog.tracks ?? {}).length)
  const iconCount = readdirSync(REAL_DIRS.loopIconsDir).filter((f) => f.endsWith('.svg')).length
  check('loop 图标 > 50', iconCount > 50, iconCount)
  const realHandler = createApiHandler({ store: realStore, record, paths: () => REAL_DIRS, loadFlowData: createFlowLoader(() => REAL_DIRS), getSchedule: () => null })
  const realCall = async (opts) => {
    const rq = fakeReq(opts)
    const rs = new FakeRes()
    const d = new Promise((resolve) => rs.on('finish', resolve))
    await realHandler(rq, rs)
    await d
    return rs
  }
  for (const cue of ['alert-work', 'alert-short-break', 'alert-long-break', 'tick']) {
    const r2 = await realCall({ url: `/pomodoro-ai/api/cue/${cue}` })
    check(`提示音 ${cue} 可播放`, r2.statusCode === 200 && Number(r2.headers['content-length']) > 1000, [r2.statusCode, r2.headers?.['content-length']])
  }
  const iconRes = await realCall({ url: '/pomodoro-ai/api/flow/icon/rain' })
  check('真实图标可取出（rain.svg）', iconRes.statusCode === 200 && iconRes.text.includes('<svg'), iconRes.statusCode)
  const flowRes = await realCall({ url: '/pomodoro-ai/api/flow/data' })
  check('真实 /flow/data 可用', flowRes.statusCode === 200 && flowRes.json.ambient.sounds.length > 50, flowRes.json?.ambient?.sounds?.length)
}

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
