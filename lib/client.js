/**
 * @dsh-external/dsh-pomodoro-ai — client 半（Phase 4：浮层 + 音频引擎）。
 *
 * 形制（照本 profile 里真实工作的 @linxin666/dsh-client-ui-skin-center）：
 *  - 手写 bundle：window.__ModuleLoader__.load({ id: 包名, factory: require => ... })
 *  - 顶层导出 inject（客户端服务依赖）与 apply（挂载点）
 *  - slot 注册是**两个参数**：register(注册对象, React 组件)
 *  - register( 与 { 必须紧邻（注入器时代留下的校验正则要求，保留无害）
 *  - shell.overlay 层本身点击穿透，条目必须自己 pointer-events: auto
 *
 * 权威在 host：这里只渲染 + 发命令。倒计时用 host 给的 deadlineAt 本地推算，
 * 所以轮询抖动或页面卡顿都不会让显示与 host 漂移。
 *
 * 音频三源（音量模型移植自 elegant-pomodoro：master × ambientRatio × 单路音量）：
 *  1. 环境音循环——FlowTunes 公共桶，多路可叠加（用户自己挑，插件不带素材）
 *  2. 音乐——FlowTunes 频道顺序播放，或本地文件夹（host 流式提供）
 * 提示音走 host 的 /cue/<name> 路由（复用用户 elegant-pomodoro 的 4 个 mp3）。
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-pomodoro-ai",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    const PKG = "@dsh-external/dsh-pomodoro-ai";
    const API = "/pomodoro-ai/api";
    const BUILD = "phase4-10";
    const POS_KEY = "pomodoro-ai.pos";
    const MINI_KEY = "pomodoro-ai.mini";
    const OPEN_KEY = "pomodoro-ai.panels";
    const SCHEME_KEY = "pomodoro-ai.scheme";

    // ── 小工具 ────────────────────────────────────────────────────────────
    function mmss(totalSec) {
      const s = Math.max(0, Math.round(totalSec));
      const m = Math.floor(s / 60);
      return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }
    function loadJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    }
    function saveJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* 隐私模式忽略 */
      }
    }
    function report(payload) {
      try {
        fetch(API + "/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }

    /**
     * 配色方案：**自带调色板，不用主题 token 决定可读性**。
     *
     * 教训（2026-10-02，用户截图）：原先主按钮用 `background: var(--dsw-alias-brand-primary)`
     * + 写死 `color:#fff`，而该 token 在用户主题里解析成近白色 → **白底白字，按钮上的字看不见**。
     * 凡是"文字压在什么颜色上"的地方，都不能托付给主题 token：对比度必须自己保证。
     *
     * 每个方案里都成对给出底色与压在上面的文字色（accent/accentText），
     * 并且都取高对比（正文 ≥ 12:1，按钮 ≥ 6:1）。
     */
    const SCHEMES = {
      // 极简黑白：只要两个颜色
      ink: {
        label: "墨白",
        surface: "#ffffff",
        border: "rgba(0,0,0,.32)",
        borderSoft: "rgba(0,0,0,.16)",
        text: "#000000",
        dim: "rgba(0,0,0,.64)",
        accent: "#000000",
        accentText: "#ffffff",
        soft: "rgba(0,0,0,.07)",
        idle: "rgba(0,0,0,.22)",
        ok: "#0b6b43",
        warn: "#7a4b00",
        long: "#0b5f66",
        shadow: "0 10px 30px rgba(0,0,0,.22)",
      },
      // 深色（默认跟随深色主题）
      slate: {
        label: "深色",
        surface: "#20242e",
        border: "rgba(255,255,255,.30)",
        borderSoft: "rgba(255,255,255,.15)",
        text: "#f5f7fb",
        dim: "rgba(245,247,251,.72)",
        accent: "#6f9bf3",
        accentText: "#0b1220",
        soft: "rgba(255,255,255,.10)",
        idle: "rgba(245,247,251,.22)",
        ok: "#4ade9f",
        warn: "#f5c04a",
        long: "#4fd1c5",
        shadow: "0 10px 32px rgba(0,0,0,.52)",
      },
      // 浅色
      paper: {
        label: "浅色",
        surface: "#f7f8fa",
        border: "rgba(0,0,0,.26)",
        borderSoft: "rgba(0,0,0,.13)",
        text: "#12151a",
        dim: "rgba(18,21,26,.66)",
        accent: "#1f5fd0",
        accentText: "#ffffff",
        soft: "rgba(0,0,0,.06)",
        idle: "rgba(18,21,26,.20)",
        ok: "#0b6b43",
        warn: "#7a4b00",
        long: "#0b5f66",
        shadow: "0 10px 30px rgba(0,0,0,.20)",
      },
    };
    const SCHEME_ORDER = ["auto", "ink", "slate", "paper"];

    /**
     * 读一个 CSS 变量。
     * 先看 body 再看 :root —— 实测（2026-10-02）DSH 的 `--dsw-alias-*` 在
     * `document.documentElement` 上是**空字符串**（不是未定义！），
     * 而 CSS 里 `var(--x, 回退值)` 遇到"变量存在但为空"会判定整条声明无效、
     * **不会**使用回退值 → background 退化成 transparent、color 变成继承。
     * 这正是"主按钮白底白字看不见"的根因，所以关键颜色一律自带、不靠 token。
     */
    function cssVar(name) {
      for (const el of [typeof document !== "undefined" ? document.body : null, typeof document !== "undefined" ? document.documentElement : null]) {
        if (!el) continue;
        try {
          const v = getComputedStyle(el).getPropertyValue(name).trim();
          if (v) return v;
        } catch (e) {
          /* 继续尝试下一个 */
        }
      }
      return "";
    }

    /** 颜色亮度（0=黑 1=白）；解析 #rgb/#rrggbb/rgb() 三种常见写法。 */
    function luminance(color) {
      const c = String(color || "").trim();
      let r = null;
      let g = null;
      let b = null;
      let m = /^#([0-9a-f]{3})$/i.exec(c);
      if (m) {
        r = parseInt(m[1][0] + m[1][0], 16);
        g = parseInt(m[1][1] + m[1][1], 16);
        b = parseInt(m[1][2] + m[1][2], 16);
      }
      m = /^#([0-9a-f]{6})$/i.exec(c);
      if (m) {
        r = parseInt(m[1].slice(0, 2), 16);
        g = parseInt(m[1].slice(2, 4), 16);
        b = parseInt(m[1].slice(4, 6), 16);
      }
      m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
      if (m) {
        r = Number(m[1]);
        g = Number(m[2]);
        b = Number(m[3]);
      }
      if (r === null || g === null || b === null) return null;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    /** 当前配色（Widget 渲染前按选择覆盖；组件都从这里取色）。 */
    let T = SCHEMES.slate;

    /** 自动模式：看 DSH 底色的亮度，亮底用 paper，暗底用 slate。 */
    function autoScheme() {
      const base = cssVar("--dsw-alias-bg-base") || cssVar("--dsw-alias-bg-layer-1");
      const lum = luminance(base);
      if (lum === null) return "slate";
      return lum > 0.55 ? "paper" : "slate";
    }

    const PHASE_LABEL = { work: "专注", "short-break": "短休", "long-break": "长休", idle: "待开始", focus: "专注", break: "短休" };
    /**
     * 迷你态里数字下方那行小字（用户要求：一眼看出是专注还是休息）。
     * 短休与长休都是 `relax` —— 两者靠圆环颜色区分（短休琥珀、长休青绿）。
     */
    const MINI_LABEL = { work: "focus", focus: "focus", "short-break": "relax", "long-break": "relax", break: "relax", idle: "ready" };
    const isWork = (p) => p === "work" || p === "focus";
    const isBreak = (p) => p === "short-break" || p === "long-break" || p === "break";
    function phaseColor(phase) {
      if (phase === "long-break") return T.long;
      if (isBreak(phase)) return T.warn;
      if (isWork(phase)) return T.accent;
      return T.idle;
    }

    // ═════════════════════════════════════════════════════════════════════
    // 音频引擎（模块级单例，不参与 React 渲染）
    // ═════════════════════════════════════════════════════════════════════
    /**
     * 发声节点注册表 + 孤儿回收。
     *
     * 事故（2026-10-02）：移除合成噪音后客户端热重载，新 bundle 里没有任何句柄指向
     * 旧 bundle 已启动的 Web Audio 节点 → **那个噪音变成孤儿，一直响且停不掉**，
     * 任何命令都无效，只能刷新页面销毁。用户听到持续巨响。
     *
     * 机制：把所有会发声的元素登记到 window 上的注册表；**新 bundle 载入的第一件事**
     * 就是 panic 掉上一版注册表里的全部节点；页面卸载时也 panic。
     * 这样"改音频代码 → 热重载"永远不会留下没人管的声音。
     */
    const AUDIO_REGISTRY_KEY = "__dshPomodoroAudioRegistry";
    try {
      const prev = window[AUDIO_REGISTRY_KEY];
      if (prev && typeof prev.panic === "function") prev.panic();
    } catch (e) {
      /* 回收失败不能影响加载 */
    }

    const registry = {
      nodes: new Set(),
      add(node) {
        this.nodes.add(node);
        return node;
      },
      /** 停掉并释放所有已登记的发声节点。 */
      panic() {
        for (const node of this.nodes) {
          try {
            node.pause();
            node.removeAttribute("src");
            node.load();
          } catch (e) {
            /* ignore */
          }
        }
        this.nodes.clear();
      },
    };
    try {
      window[AUDIO_REGISTRY_KEY] = registry;
    } catch (e) {
      /* ignore */
    }
    try {
      const panic = () => registry.panic();
      window.addEventListener("pagehide", panic);
      window.addEventListener("beforeunload", panic);
    } catch (e) {
      /* ignore */
    }

    /**
     * 播放并处理被拦截的情况。
     * 浏览器自动播放策略：页面获得过用户手势后，后续程序化 .play() 才被允许。
     * 被拒时置 blocked 并上报——界面会提示用户点一下（取代原先的 AudioContext unlock）。
     */
    function play(el, tag) {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          audio.blocked = true;
          report({ stage: "play-blocked", tag, error: String(err && err.name ? err.name : err) });
        });
      }
    }

    const audio = {
      loops: new Map(),
      music: { el: null, channelId: null, trackIndex: 0, tracks: [], urls: [] },
      cues: new Map(),
      /** 浏览器拦截了自动播放（.play() 被拒）时置位，界面据此提示用户点一下。 */
      blocked: false,
      /** 环境音：按 host 给的列表增删，音量 = master × ratio × 单路。 */
      syncLoops(list, master, ratio, base) {
        const wanted = new Map((list || []).map((l) => [l.id, l]));
        for (const [id, entry] of this.loops) {
          if (!wanted.has(id)) {
            try {
              entry.el.pause();
            } catch (e) {
              /* ignore */
            }
            this.loops.delete(id);
          }
        }
        for (const [id, item] of wanted) {
          let entry = this.loops.get(id);
          if (!entry) {
            const el = registry.add(new Audio(base + "/loop-audio-v3/" + id + ".m4a"));
            el.loop = true;
            el.crossOrigin = "anonymous";
            el.addEventListener("error", () => report({ stage: "loop-error", id }));
            entry = { el };
            this.loops.set(id, entry);
          }
          entry.el.volume = Math.max(0, Math.min(1, master * ratio * (item.volume ?? 0.375)));
          if (entry.el.paused) play(entry.el, "loop:" + id);
        }
      },

      stopLoops() {
        for (const entry of this.loops.values()) {
          try {
            entry.el.pause();
          } catch (e) {
            /* ignore */
          }
        }
      },

      setMusic(playing, urls, trackIndex, volume) {
        const m = this.music;
        if (!m.el) {
          m.el = registry.add(new Audio());
          m.el.addEventListener("ended", () => {
            if (m.onEnded) m.onEnded();
          });
        }
        m.urls = urls || [];
        if (m.urls.length === 0) {
          m.el.pause();
          return;
        }
        const idx = Math.max(0, Math.min(m.urls.length - 1, trackIndex || 0));
        const url = m.urls[idx];
        if (m.el.src !== url && !m.el.src.endsWith(url)) {
          m.el.src = url;
          m.el.load();
        }
        m.el.volume = Math.max(0, Math.min(1, volume));
        if (playing) play(m.el, "music");
        else m.el.pause();
      },

      stopMusic() {
        if (this.music.el) {
          try {
            this.music.el.pause();
          } catch (e) {
            /* ignore */
          }
        }
      },

      playCue(name, volume) {
        try {
          let el = this.cues.get(name);
          if (!el) {
            el = registry.add(new Audio(API + "/cue/" + name));
            this.cues.set(name, el);
          }
          el.volume = Math.max(0, Math.min(1, volume));
          el.currentTime = 0;
          play(el, "cue:" + name);
        } catch (e) {
          /* ignore */
        }
      },

      stopAll() {
        this.stopLoops();
        this.stopMusic();
      },
    };

    // ═════════════════════════════════════════════════════════════════════
    // 组件
    // ═════════════════════════════════════════════════════════════════════
    function Ring(props) {
      const size = props.size;
      const stroke = props.stroke;
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const ratio = Math.max(0, Math.min(1, props.ratio));
      return react.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 " + size + " " + size, style: { display: "block" } },
        react.createElement("circle", { cx: size / 2, cy: size / 2, r: r, fill: "none", stroke: T.idle, strokeWidth: stroke, opacity: 0.28 }),
        react.createElement("circle", {
          cx: size / 2,
          cy: size / 2,
          r: r,
          fill: "none",
          stroke: props.color,
          strokeWidth: stroke,
          strokeLinecap: "round",
          strokeDasharray: String(c),
          strokeDashoffset: String(c * (1 - ratio)),
          transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")",
          style: { transition: "stroke-dashoffset .12s linear, stroke .3s linear" },
        })
      );
    }

    function Btn(props) {
      return react.createElement(
        "button",
        {
          type: "button",
          onClick: props.onClick,
          title: props.title,
          style: {
            pointerEvents: "auto",
            cursor: "pointer",
            font: "inherit",
            fontSize: props.small ? "10.5px" : "12px",
            lineHeight: "1.2",
            padding: props.primary ? "6px 12px" : props.small ? "2px 6px" : "5px 9px",
            borderRadius: "8px",
            color: props.primary ? T.accentText : props.active ? T.text : T.dim,
            background: props.primary ? T.accent : props.active ? T.soft : "transparent",
            border: "1px solid " + (props.primary ? "transparent" : props.active ? T.border : T.borderSoft),
            whiteSpace: "nowrap",
          },
        },
        props.children
      );
    }

    function Row(props) {
      return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "6px" } }, props.children);
    }

    function PanelTitle(props) {
      return react.createElement(
        "div",
        { onClick: props.onClick, style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "11px", color: T.dim, marginTop: "8px" } },
        react.createElement("span", null, props.open ? "▾" : "▸"),
        react.createElement("span", { style: { flex: 1 } }, props.children),
        props.extra ? react.createElement("span", null, props.extra) : null
      );
    }

    function WeekBars(props) {
      const days = props.days || [];
      const max = Math.max(1, ...days.map((d) => d.focusCount));
      return react.createElement(
        "div",
        { style: { display: "flex", alignItems: "flex-end", gap: "3px", height: "26px", marginTop: "4px" } },
        days.map((d, i) =>
          react.createElement("div", {
            key: d.day || i,
            title: `${d.day} · ${d.focusCount} 个 / ${Math.round(d.focusSec / 60)} 分钟`,
            style: {
              flex: 1,
              height: Math.max(2, Math.round((d.focusCount / max) * 24)) + "px",
              background: i === days.length - 1 ? T.accent : T.idle,
              borderRadius: "2px",
            },
          })
        )
      );
    }

    function Widget() {
      const [snap, setSnap] = react.useState(null);
      const [err, setErr] = react.useState(null);
      const [, forceTick] = react.useState(0);
      const [mini, setMini] = react.useState(() => loadJSON(MINI_KEY, false) === true);
      const [pos, setPos] = react.useState(() => loadJSON(POS_KEY, { right: 18, bottom: 18 }));
      const [panels, setPanels] = react.useState(() => loadJSON(OPEN_KEY, { plan: true, sound: false, week: false }));
      const [flow, setFlow] = react.useState(null);
      const [pickerOpen, setPickerOpen] = react.useState(false);
      const [soundHint, setSoundHint] = react.useState(false);
      // 配色选择：auto / ink / slate / paper（放在最后，改动不影响前面 hook 的顺序）
      const [scheme, setScheme] = react.useState(() => loadJSON(SCHEME_KEY, "auto"));

      const dragRef = react.useRef(null);
      const aliveRef = react.useRef(true);
      const reportedRef = react.useRef(false);
      const lastCueRef = react.useRef(0);
      const tickSecRef = react.useRef(-1);

      const setPanel = (key, value) =>
        setPanels((p) => {
          const next = { ...p, [key]: value };
          saveJSON(OPEN_KEY, next);
          return next;
        });

      // 权威快照轮询
      react.useEffect(() => {
        aliveRef.current = true;
        let timer = null;
        const pull = () => {
          fetch(API + "/state", { cache: "no-store" })
            .then((res) => res.json())
            .then((json) => {
              if (!aliveRef.current) return;
              if (json && json.ok) {
                setSnap(json);
                setErr(null);
                if (!reportedRef.current) {
                  reportedRef.current = true;
                  report({ stage: "state-ok", build: BUILD, phase: json.phase, runState: json.runState, roundsPerCycle: json.roundsPerCycle });
                }
              } else setErr("state 响应异常");
            })
            .catch((e) => {
              const msg = String(e && e.message ? e.message : e);
              if (aliveRef.current) setErr(msg);
              if (!reportedRef.current) {
                reportedRef.current = true;
                report({ stage: "state-fail", build: BUILD, error: msg });
              }
            });
        };
        pull();
        timer = setInterval(pull, 1000);
        report({
          stage: "widget-mounted",
          build: BUILD,
          // 诊断：主题 token 到底解析成了什么（"白底白字"事故就是靠这个定位的）
          scheme: loadJSON(SCHEME_KEY, "auto"),
          autoResolved: autoScheme(),
          tokens: {
            bgBase: cssVar("--dsw-alias-bg-base"),
            bgOverlay: cssVar("--dsw-alias-bg-overlay"),
            labelPrimary: cssVar("--dsw-alias-label-primary"),
            brandPrimary: cssVar("--dsw-alias-brand-primary"),
            borderL2: cssVar("--dsw-alias-border-l2"),
          },
        });
        return () => {
          aliveRef.current = false;
          if (timer) clearInterval(timer);
        };
      }, []);

      // 本地重绘（倒计时 + 滴答声）
      // 120ms 一轮：圆环要"像燃烧一样"连续缩短，秒级刷新会一跳一跳的。
      react.useEffect(() => {
        const id = setInterval(() => {
          forceTick((n) => n + 1);
          const s = snapRef.current;
          if (!s) return;
          if (s.runState === "running") {
            const sec = Math.floor(Date.now() / 1000);
            if (sec !== tickSecRef.current) {
              tickSecRef.current = sec;
              const wantTick = (isWork(s.phase) && s.config.tickDuringWork) || (isBreak(s.phase) && s.config.tickDuringBreak);
              if (wantTick) audio.playCue("tick", s.config.cueVolume);
            }
          }
        }, 120);
        return () => clearInterval(id);
      }, []);

      const snapRef = react.useRef(null);
      react.useEffect(() => {
        snapRef.current = snap;
      }, [snap]);

      // 阶段结束提示音：盯 lastEvent 的变化
      react.useEffect(() => {
        if (!snap || !snap.lastEvent) return;
        const ev = snap.lastEvent;
        if (ev.type !== "phase.complete") return;
        if (ev.t === lastCueRef.current) return;
        lastCueRef.current = ev.t;
        const name = isWork(ev.phase) ? "alert-work" : ev.phase === "long-break" ? "alert-long-break" : "alert-short-break";
        audio.playCue(name, snap.config.cueVolume);
        report({ stage: "cue-played", name, phase: ev.phase });
      }, [snap]);

      // 音频与 host 状态同步
      react.useEffect(() => {
        if (!snap) return;
        const n = snap.noise;
        const base = flow ? flow.audioBase : null;
        if (!n.on) {
          audio.stopLoops();
          audio.stopMusic();
          return;
        }
        if (base) audio.syncLoops(n.loops, n.master, n.ambientRatio, base);
        // 音乐：把频道/本地曲目解析成 URL 列表
        const channelId = n.music.channelId;
        let urls = [];
        if (flow && channelId) {
          if (channelId === "local") urls = (flow.local?.tracks ?? []).map((t) => t.url);
          else {
            const ids = (flow.catalog?.tracks ?? {})[channelId] ?? [];
            urls = ids.map((id) => flow.trackUrlTemplate.replace("{id}", id));
          }
        }
        audio.music.onEnded = () => {
          const next = (audio.music.trackIndex + 1) % Math.max(1, audio.music.urls.length);
          fetch(API + "/command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "noise.set", payload: { music: { trackIndex: next } }, source: "widget" }),
          }).catch(() => {});
        };
        audio.music.trackIndex = n.music.trackIndex;
        audio.setMusic(n.music.on, urls, n.music.trackIndex, n.master * n.music.volume);
      }, [snap, flow]);

      const cmd = react.useCallback((action, payload) => {
        fetch(API + "/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: action, payload: payload || {}, source: "widget" }),
        })
          .then((res) => res.json())
          .then((json) => {
            if (!aliveRef.current) return;
            if (json && json.snapshot) setSnap(json.snapshot);
            if (json && json.ok === false) setErr(String(json.error));
            else setErr(null);
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)));
      }, []);

      /**
       * 用户手势入口：清掉"被拦截"标记，让随后的 .play() 有用户激活可用。
       * （合成噪音移除后不再需要 AudioContext，这里只是重置提示状态。）
       */
      const ensureAudio = react.useCallback(async () => {
        audio.blocked = false;
        setSoundHint(false);
        return true;
      }, []);

      const loadFlow = react.useCallback(() => {
        if (flow) return;
        fetch(API + "/flow/data")
          .then((res) => res.json())
          .then((json) => {
            if (json && json.ok) {
              setFlow(json);
              report({ stage: "flow-loaded", sounds: json.ambient?.sounds?.length ?? 0, channels: json.channels?.length ?? 0, missing: json.missing });
            }
          })
          .catch(() => {});
      }, [flow]);

      // 拖动
      const onDown = react.useCallback((e) => {
        if (e.button !== 0) return;
        const box = e.currentTarget.parentElement.getBoundingClientRect();
        dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, w: box.width, h: box.height };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (e2) {
          /* ignore */
        }
      }, []);
      const onMove = react.useCallback((e) => {
        const d = dragRef.current;
        if (!d) return;
        const right = Math.max(4, Math.min(window.innerWidth - 60, window.innerWidth - (e.clientX - d.dx) - d.w));
        const bottom = Math.max(4, Math.min(window.innerHeight - 40, window.innerHeight - (e.clientY - d.dy) - d.h));
        setPos({ right: right, bottom: bottom });
      }, []);
      const onUp = react.useCallback((e) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch (e2) {
          /* ignore */
        }
        setPos((p) => {
          saveJSON(POS_KEY, p);
          return p;
        });
      }, []);

      const toggleMini = () => setMini((m) => { saveJSON(MINI_KEY, !m); return !m; });

      /**
       * 迷你态的指针处理：**拖动搬位置，轻点展开**。
       * 位移超过 4px 就认定是拖动（不展开），否则松手即展开——
       * 否则"点一下展开"和"拖到别处"会互相打架。
       */
      const miniDrag = react.useRef(null);
      const onMiniDown = react.useCallback((e) => {
        if (e.button !== 0) return;
        miniDrag.current = { x: e.clientX, y: e.clientY, moved: false };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (e2) {
          /* ignore */
        }
      }, []);
      const onMiniMove = react.useCallback((e) => {
        const d = miniDrag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        d.moved = true;
        const right = Math.max(4, Math.min(window.innerWidth - 60, window.innerWidth - e.clientX - 20));
        const bottom = Math.max(4, Math.min(window.innerHeight - 40, window.innerHeight - e.clientY - 20));
        setPos({ right: right, bottom: bottom });
      }, []);
      const onMiniUp = react.useCallback((e) => {
        const d = miniDrag.current;
        miniDrag.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch (e2) {
          /* ignore */
        }
        if (!d) return;
        if (d.moved) {
          setPos((p) => {
            saveJSON(POS_KEY, p);
            return p;
          });
        } else {
          setMini(false);
          saveJSON(MINI_KEY, false);
        }
      }, []);

      // 生效配色：auto 跟随 DSH 底色亮度，其余用显式方案。
      // 注意：必须在这里（hooks 之后、构建元素之前）落地，子组件才拿得到正确颜色。
      const effectiveScheme = scheme === "auto" ? autoScheme() : scheme;
      T = SCHEMES[effectiveScheme] ?? SCHEMES.slate;
      const cycleScheme = () => {
        const next = SCHEME_ORDER[(SCHEME_ORDER.indexOf(scheme) + 1) % SCHEME_ORDER.length];
        saveJSON(SCHEME_KEY, next);
        setScheme(next);
        report({ stage: "scheme-changed", scheme: next, effective: next === "auto" ? autoScheme() : next });
      };

      if (!snap) {
        return react.createElement(
          "div",
          {
            "data-dsh-plugin": PKG,
            style: {
              position: "fixed", right: pos.right + "px", bottom: pos.bottom + "px", zIndex: 60, pointerEvents: "auto",
              padding: "8px 12px", borderRadius: "10px", background: T.surface, color: T.dim, border: "1px solid " + T.border,
              font: "12px/1.4 system-ui, -apple-system, sans-serif",
            },
          },
          "🍅 番茄钟连接中…" + (err ? "（" + err + "）" : "")
        );
      }

      const running = snap.runState === "running";
      // 亚秒精度：圆环要连续缩短（"燃烧"），按整秒取会让它一跳一跳。
      // 数字仍按秒显示（Math.ceil，和 host 的 remainingSec 语义一致）。
      const remainingMs = running && snap.deadlineAt ? Math.max(0, snap.deadlineAt - Date.now()) : snap.remainingSec * 1000;
      const remaining = Math.ceil(remainingMs / 1000);
      const ratio = snap.plannedSec > 0 ? Math.max(0, Math.min(1, remainingMs / (snap.plannedSec * 1000))) : 0;
      const color = phaseColor(snap.phase);
      const label = (PHASE_LABEL[snap.phase] ?? snap.phase) + (snap.runState === "paused" && snap.phase !== "idle" ? "（已暂停）" : "");
      const plan = snap.plan;
      const totalEst = plan ? plan.tasks.reduce((s, t) => s + (t.estimate || 0), 0) : 0;
      const totalSpent = plan ? plan.tasks.reduce((s, t) => s + (t.spent || 0), 0) : 0;
      const noise = snap.noise;
      const sounds = flow?.ambient?.sounds ?? [];
      const channels = flow?.channels ?? [];

      const header = react.createElement(
        "div",
        { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, style: { display: "flex", alignItems: "center", gap: "8px", cursor: "grab", touchAction: "none", marginBottom: "6px" } },
        react.createElement("span", { style: { fontSize: "14px" } }, "🍅"),
        react.createElement("span", { style: { fontSize: "12px", fontWeight: 600, color: T.text } }, "番茄钟"),
        react.createElement("span", { style: { flex: 1 } }),
        react.createElement("button", {
          type: "button",
          onPointerDown: (e) => e.stopPropagation(),
          onClick: cycleScheme,
          title: "配色方案：自动 / 墨白 / 深色 / 浅色（点击切换）",
          style: { pointerEvents: "auto", cursor: "pointer", font: "inherit", fontSize: "11px", padding: "2px 6px", borderRadius: "6px", color: T.text, background: T.soft, border: "1px solid " + T.border },
        }, scheme === "auto" ? "配色·自动" : "配色·" + (SCHEMES[scheme]?.label ?? scheme)),
        react.createElement("button", {
          type: "button",
          onPointerDown: (e) => e.stopPropagation(),
          onClick: toggleMini,
          title: mini ? "展开" : "迷你",
          style: { pointerEvents: "auto", cursor: "pointer", font: "inherit", fontSize: "11px", padding: "2px 6px", borderRadius: "6px", color: T.dim, background: "transparent", border: "1px solid " + T.border },
        }, mini ? "展开" : "迷你")
      );

      const dial = react.createElement(
        "div",
        { style: { position: "relative", width: 128, height: 128, margin: "0 auto" } },
        react.createElement(Ring, { size: 128, stroke: 8, ratio: ratio, color: color }),
        react.createElement(
          "div",
          { style: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px" } },
          react.createElement("div", { style: { fontSize: "25px", fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums" } }, mmss(remaining)),
          react.createElement("div", { style: { fontSize: "11px", color: color } }, label)
        )
      );

      /**
       * 迷你态：**只有一个圈 + 中间的数字**，没有任何其他文字/按钮。
       * 点一下展开；按住拖动仍然可以搬位置（位移超过阈值就算拖动，不触发展开）。
       */
      const miniSize = 82;
      const miniDial = react.createElement(
        "div",
        {
          onPointerDown: onMiniDown,
          onPointerMove: onMiniMove,
          onPointerUp: onMiniUp,
          onPointerCancel: onMiniUp,
          title: label + " · " + mmss(remaining) + "（点击展开）",
          style: {
            position: "relative", width: miniSize + "px", height: miniSize + "px", borderRadius: "50%",
            background: T.surface, border: "1px solid " + T.border, boxShadow: T.shadow,
            cursor: "pointer", pointerEvents: "auto", touchAction: "none", userSelect: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        },
        react.createElement(Ring, { size: miniSize - 4, stroke: 5, ratio: ratio, color: snap.runState === "paused" && snap.phase !== "idle" ? T.idle : color }),
        react.createElement(
          "div",
          { style: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0px" } },
          react.createElement("div", { style: { fontSize: "16px", fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.3px", lineHeight: "1.1" } }, mmss(remaining)),
          react.createElement(
            "div",
            { style: { fontSize: "9px", letterSpacing: "0.6px", color: color, lineHeight: "1.1", textTransform: "lowercase" } },
            MINI_LABEL[snap.phase] ?? "focus"
          )
        )
      );

      const controls = react.createElement(
        "div",
        { style: { display: "flex", gap: "6px", justifyContent: "center", marginTop: "8px", flexWrap: "wrap" } },
        react.createElement(
          Btn,
          { primary: true, onClick: () => (running ? cmd("pause") : snap.runState === "paused" && snap.phase !== "idle" ? cmd("resume") : cmd("start")) },
          running ? "暂停" : snap.runState === "paused" && snap.phase !== "idle" ? "继续" : "开始专注"
        ),
        snap.phase !== "idle" ? react.createElement(Btn, { onClick: () => cmd("skip") }, "跳过") : null,
        snap.phase !== "idle" ? react.createElement(Btn, { onClick: () => cmd("reset") }, "重置") : null,
        snap.phase !== "idle" ? react.createElement(Btn, { onClick: () => cmd("stop") }, "停止") : null
      );

      const roundLine = react.createElement(
        "div",
        { style: { marginTop: "8px", fontSize: "12px", color: T.dim, textAlign: "center" } },
        "第 " + snap.workRoundNumber + "/" + snap.roundsPerCycle + " 个番茄",
        snap.nextRoundHint === "long-break" ? " · 下一个是长休 🌿" : "",
        snap.taskTitle ? react.createElement("div", { style: { marginTop: "2px", color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, snap.taskTitle) : null,
        totalEst > 0 ? react.createElement("div", { style: { marginTop: "2px", opacity: 0.8 } }, "计划 " + totalSpent + "/" + totalEst) : null
      );

      const planBlock =
        !mini && plan
          ? react.createElement(
              "div",
              null,
              react.createElement(PanelTitle, { open: panels.plan, onClick: () => setPanel("plan", !panels.plan), extra: plan.tasks.filter((t) => t.done).length + "/" + plan.tasks.length }, plan.title),
              panels.plan
                ? react.createElement(
                    "div",
                    { style: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" } },
                    plan.tasks.slice(0, 8).map((task) =>
                      react.createElement(
                        "div",
                        { key: task.id, style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: task.id === snap.taskId ? T.text : T.dim, opacity: task.done ? 0.55 : 1 } },
                        react.createElement("span", { onClick: () => cmd("plan.toggle", { taskId: task.id }), title: "标记完成", style: { cursor: "pointer", pointerEvents: "auto" } }, task.done ? "☑" : "☐"),
                        react.createElement("span", { onClick: () => cmd("plan.select", { taskId: task.id }), title: "设为当前任务", style: { cursor: "pointer", pointerEvents: "auto", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: task.done ? "line-through" : "none" } }, task.title),
                        react.createElement("span", { style: { fontVariantNumeric: "tabular-nums" } }, (task.spent || 0) + "/" + task.estimate)
                      )
                    )
                  )
                : null
            )
          : null;

      const soundBlock =
        !mini
          ? react.createElement(
              "div",
              null,
              react.createElement(
                PanelTitle,
                {
                  open: panels.sound,
                  onClick: () => {
                    setPanel("sound", !panels.sound);
                    if (!panels.sound) loadFlow();
                  },
                  extra: noise.on ? "开" : "关",
                },
                "声音"
              ),
              panels.sound
                ? react.createElement(
                    "div",
                    { style: { marginTop: "4px" } },
                    react.createElement(
                      Row,
                      null,
                      react.createElement(Btn, { small: true, active: noise.on, onClick: async () => { await ensureAudio(); cmd("noise.set", { on: !noise.on }); } }, noise.on ? "总开关 开" : "总开关 关"),
                      react.createElement("span", { style: { fontSize: "10.5px", color: T.dim } }, "总音量"),
                      react.createElement("input", {
                        type: "range", min: "0", max: "1", step: "0.05", value: noise.master,
                        onChange: (e) => cmd("noise.set", { master: Number(e.target.value) }),
                        style: { flex: 1, pointerEvents: "auto", accentColor: T.accent },
                      })
                    ),
                    react.createElement(
                      Row,
                      null,
                      react.createElement("span", { style: { fontSize: "10.5px", color: T.dim, width: "34px" } }, "环境音"),
                      react.createElement(Btn, { small: true, active: pickerOpen, onClick: () => { setPickerOpen((v) => !v); loadFlow(); } }, pickerOpen ? "收起" : "添加"),
                      noise.loops.length > 0
                        ? react.createElement(
                            "span",
                            { style: { flex: 1, display: "flex", gap: "4px", flexWrap: "wrap" } },
                            noise.loops.map((l) =>
                              react.createElement(
                                "span",
                                { key: l.id, title: "点击移除", onClick: () => cmd("noise.set", { removeLoop: l.id }), style: { cursor: "pointer", pointerEvents: "auto", fontSize: "10.5px", color: T.text, border: "1px solid " + T.border, borderRadius: "6px", padding: "1px 5px" } },
                                l.id + " ×" + l.volume.toFixed(2)
                              )
                            )
                          )
                        : react.createElement("span", { style: { fontSize: "10.5px", color: T.dim } }, "未选择")
                    ),
                    pickerOpen
                      ? react.createElement(
                          "div",
                          { style: { marginTop: "4px", maxHeight: "132px", overflowY: "auto", display: "flex", flexWrap: "wrap", gap: "4px" } },
                          sounds.length === 0
                            ? react.createElement("span", { style: { fontSize: "10.5px", color: T.dim } }, flow?.missing?.length ? "缺数据文件：" + flow.missing.join(", ") : "加载中…")
                            : sounds.map((s) =>
                                react.createElement(
                                  "button",
                                  {
                                    key: s.id, type: "button", title: s.title || s.id,
                                    onClick: async () => { await ensureAudio(); cmd("noise.set", { on: true, addLoop: { id: s.id } }); },
                                    style: { pointerEvents: "auto", cursor: "pointer", display: "flex", alignItems: "center", gap: "3px", fontSize: "10.5px", padding: "2px 5px", borderRadius: "6px", color: noise.loops.some((l) => l.id === s.id) ? T.text : T.dim, background: noise.loops.some((l) => l.id === s.id) ? T.soft : "transparent", border: "1px solid " + T.borderSoft },
                                  },
                                  react.createElement("img", { src: API + "/flow/icon/" + s.id, width: 12, height: 12, alt: "", onError: (e) => { e.currentTarget.style.display = "none"; } }),
                                  s.title || s.id
                                )
                              )
                        )
                      : null,
                    react.createElement(
                      Row,
                      null,
                      react.createElement("span", { style: { fontSize: "10.5px", color: T.dim, width: "34px" } }, "音乐"),
                      react.createElement(Btn, { small: true, active: noise.music.on, onClick: async () => { await ensureAudio(); cmd("noise.set", { on: true, music: { on: !noise.music.on } }); } }, noise.music.on ? "暂停" : "播放"),
                      react.createElement(
                        "select",
                        {
                          value: noise.music.channelId ?? "",
                          onChange: (e) => cmd("noise.set", { on: true, music: { channelId: e.target.value, on: true } }),
                          style: { pointerEvents: "auto", flex: 1, font: "inherit", fontSize: "10.5px", color: T.text, background: "transparent", border: "1px solid " + T.borderSoft, borderRadius: "6px", padding: "1px 3px" },
                        },
                        react.createElement("option", { value: "" }, "选频道…"),
                        channels.map((c) => react.createElement("option", { key: c.id, value: c.id }, c.title)),
                        (flow?.local?.tracks?.length ?? 0) > 0 ? react.createElement("option", { value: "local" }, "本地文件夹（" + flow.local.tracks.length + "）") : null
                      ),
                      react.createElement(Btn, { small: true, onClick: () => cmd("noise.set", { music: { trackIndex: Math.max(0, noise.music.trackIndex - 1) } }) }, "◀"),
                      react.createElement(Btn, { small: true, onClick: () => cmd("noise.set", { music: { trackIndex: noise.music.trackIndex + 1 } }) }, "▶")
                    ),
                    soundHint || audio.blocked ? react.createElement("div", { style: { fontSize: "10.5px", color: T.warn, marginTop: "4px" } }, "浏览器拦截了自动播放——点一下上面的按钮即可启用声音") : null
                  )
                : null
            )
          : null;

      const weekBlock =
        !mini
          ? react.createElement(
              "div",
              null,
              react.createElement(PanelTitle, { open: panels.week, onClick: () => setPanel("week", !panels.week), extra: "共 " + snap.week.totals.focusCount + " 个" }, "近 7 天"),
              panels.week ? react.createElement(WeekBars, { days: snap.week.days }) : null
            )
          : null;

      const footer = react.createElement(
        "div",
        { style: { marginTop: "6px", fontSize: "11px", color: T.dim, display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
        react.createElement("span", null, "今日 " + snap.stats.todayFocusCount + " 个"),
        react.createElement("span", null, Math.round(snap.stats.todayFocusSec / 60) + " 分钟"),
        react.createElement("span", null, "暂停 " + snap.stats.todayPauseCount + " 次"),
        snap.stats.todayOfflineCount > 0 ? react.createElement("span", { title: "含关机期间走完、无法核实的番茄" }, "离线 " + snap.stats.todayOfflineCount) : null
      );

      // 迷你态：**只有那一个圆**（圈 + 数字），其它一律不渲染。
      // 之前迷你态仍然渲染 header/controls/roundLine，所以看着还是很大。
      if (mini) {
        return react.createElement(
          "div",
          {
            "data-dsh-plugin": PKG,
            style: {
              position: "fixed", right: pos.right + "px", bottom: pos.bottom + "px", zIndex: 60,
              pointerEvents: "auto", font: "13px/1.4 system-ui, -apple-system, sans-serif", userSelect: "none",
            },
          },
          miniDial
        );
      }

      return react.createElement(
        "div",
        {
          "data-dsh-plugin": PKG,
          style: {
            position: "fixed", right: pos.right + "px", bottom: pos.bottom + "px", zIndex: 60, width: "252px",
            pointerEvents: "auto", padding: "10px 12px 12px", borderRadius: "14px", background: T.surface, color: T.text,
            border: "1px solid " + T.border, boxShadow: T.shadow,
            font: "13px/1.4 system-ui, -apple-system, sans-serif", userSelect: "none",
          },
        },
        header,
        dial,
        controls,
        roundLine,
        planBlock,
        soundBlock,
        weekBlock,
        footer,
        err ? react.createElement("div", { style: { marginTop: "6px", fontSize: "10.5px", color: T.dim, textAlign: "center" } }, "⚠ " + err) : null
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() => {
        const slots = ctx.slots;
        if (!slots || typeof slots.register !== "function") {
          try {
            console.log("[pomodoro-ai] 没有 slots 服务，跳过注册");
          } catch (e) {
            /* ignore */
          }
          return () => {};
        }
        const mount = () => {
          try {
            return slots.register({ name: "shell.overlay", id: "pomodoro-ai.widget", order: 10, label: () => "番茄钟" }, Widget);
          } catch (e) {
            try {
              console.log("[pomodoro-ai] register 失败", String(e));
            } catch (e2) {
              /* ignore */
            }
            return () => {};
          }
        };
        if (typeof slots.inject === "function") return slots.inject("shell.overlay", mount);
        return mount();
      }, "pomodoro-ai: overlay widget");
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
