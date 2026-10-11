/* ============================================================================
 * ball.js — 悬浮窗「球页」逻辑（file:///android_asset/ball/index.html）
 *
 * 职责：
 *   1) 挂载 MIT 的 Grok Ball 引擎（engine.js，window.EmotionBall）画 32 个表情；
 *   2) 实现 window.__dshOverlay.{state,host,settings,cmd} 四个入口，全程容错；
 *   3) 手势：拖动（>8px 取消 tap）/ 单击（自旋 + 撒花 + 说一句）/ 长按 0.5s；
 *   4) 通过 window.DshOverlayHost.post(jsonString) 上报，宿主不存在时静默。
 *
 * 本页**不画气泡**（v1 修订 A）：气泡是独立窗口，见 bubble.html / bubble.js。
 * 球页收到带 bubble 的 state 只上报 wantSay，由 App 决定开不开气泡窗。
 *
 * 性能：全页只有一个 rAF（渲染调度器）；无状态变化即停；空闲 1fps 心跳上报。
 * 对外名字、字段以 docs/INTERFACES.md v1 为准。
 * ========================================================================== */
(function () {
  "use strict";

  /* ============================ 常量 ============================ */

  /* 手势坐标（CSS px）→ 屏幕物理 px 的缩放，App 开窗时注入 window.__DSH_DENSITY */
  function density() {
    var d = typeof window !== "undefined" ? window.__DSH_DENSITY : 0;
    return typeof d === "number" && isFinite(d) && d > 0 ? d : 1;
  }

  var DRAG_THRESHOLD = 8;             /* 位移 > 8 逻辑 px 取消 tap */
  var HOLD_MS = 500;                  /* 长按 0.5s */
  var REPORT_DX = 8;                  /* drag 上报节流：累积 8 逻辑 px */
  var REPORT_MIN_MS = 40;             /* drag 上报节流：最短间隔 */
  var HEARTBEAT_MS = 1000;            /* 空闲心跳：1fps，只上报不重绘 */

  var SIZE_DEFAULT = 96;
  var SIZE_MIN = 32;
  var SIZE_MAX = 320;

  /* 主题色（契约：dark = #1A1A1A/#F5F5F5；cream = #F3F0EA/#1A1A1A） */
  var THEMES = {
    dark: { color: "#1A1A1A", eyeColor: "#F5F5F5" },
    cream: { color: "#F3F0EA", eyeColor: "#1A1A1A" }
  };
  function themeColors(name) {
    return THEMES[name === "cream" ? "cream" : "dark"];
  }

  /* 32 个表情 ID 全集（和 grok-ball 引擎一致，不许自创；名字与契约第 2 节逐字相同）。
   * 悬浮窗页不能依赖 dsh 模块表，所以这里自建一份。 */
  var LIFE_NAMES = ["睡眠", "唤醒", "待机放空", "好奇", "发呆", "加载苏醒", "休眠", "抖动唤醒"];
  var EMOTION_NAMES = ["开心", "疑惑", "失落", "惊讶", "害羞", "疲惫", "专注", "慌张", "无奈", "满意", "困惑", "生气"];
  var AGENT_NAMES = ["思考中", "接收任务", "处理中忙碌", "任务完成", "出错", "等待输入", "联网加载", "复述回忆", "拒绝受限", "输出回复", "检索资料", "停止终止"];

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  var EMOTIONS = (function () {
    var out = [], i;
    for (i = 0; i < LIFE_NAMES.length; i++) out.push({ id: pad2(i), name: LIFE_NAMES[i], group: "life" });
    for (i = 0; i < EMOTION_NAMES.length; i++) out.push({ id: pad2(10 + i), name: EMOTION_NAMES[i], group: "emotion" });
    for (i = 0; i < AGENT_NAMES.length; i++) out.push({ id: pad2(30 + i), name: AGENT_NAMES[i], group: "agent" });
    return out;
  })();

  var EMOTION_BY_ID = (function () {
    var map = {};
    for (var i = 0; i < EMOTIONS.length; i++) map[EMOTIONS[i].id] = EMOTIONS[i];
    return map;
  })();

  function emotionName(id) {
    var found = EMOTION_BY_ID[id];
    return found ? found.name : "";
  }
  function isKnownEmotion(id) { return !!EMOTION_BY_ID[id]; }

  /* 气泡色调：和网页版 20-ball.js 的 bubbleTone 逐档一致 */
  var TONE_WARM = { "10": 1, "19": 1, "33": 1, "14": 1, "13": 1 };
  var TONE_BLUE = { "12": 1, "15": 1, "18": 1, "21": 1 };
  var TONE_ALERT = { "17": 1, "34": 1, "38": 1 };
  var TONE_WORK = { "30": 1, "16": 1, "32": 1, "40": 1, "31": 1, "37": 1 };
  function bubbleTone(moodId) {
    var id = String(moodId == null ? "" : moodId).replace(/^\s+|\s+$/g, "");
    if (/^\d$/.test(id)) id = "0" + id;
    if (TONE_WARM[id]) return "warm";
    if (TONE_BLUE[id]) return "blue";
    if (TONE_ALERT[id]) return "alert";
    if (TONE_WORK[id]) return "work";
    return "plain";
  }

  /* 本地兜底台词：零 token、零网络请求，只用于「悬浮球自己拼一句」 */
  var LOCAL_LINES = {
    "10": ["嘿嘿～", "今天风都往我这边吹"],
    "12": ["……缓一缓就好", "让我蹲一会儿"],
    "13": ["欸？！没料到"],
    "14": ["别夸我啦……"],
    "17": ["别慌别慌，我先看看"],
    "18": ["行吧，那就先这样"],
    "19": ["嗯，这样就很舒服了"],
    "21": ["哼，我暂时不说话了"],
    "30": ["我在想……别催我"],
    "16": ["安静点，我在看日志"],
    "15": ["呼……有点累了"],
    "33": ["搞定！撒个花"],
    "34": ["哎哟，出错了……"],
    "35": ["我在这儿，你说"],
    "*": ["我在呢", "嗯，我在这儿"]
  };
  function localLine(id) {
    var pool = LOCAL_LINES[id] || LOCAL_LINES["*"];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ============================ 工具 ============================ */

  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isPlainObject(v) { return !!v && typeof v === "object" && !(v instanceof Array); }
  function trim(v) { return String(v == null ? "" : v).replace(/^\s+|\s+$/g, ""); }

  /* 永不抛：解析 App 透传的 JSON，坏数据一律当空对象 */
  function parseJson(input) {
    if (isPlainObject(input)) return input;
    if (typeof input !== "string" || !input) return {};
    try {
      var v = JSON.parse(input);
      return isPlainObject(v) ? v : {};
    } catch (err) {
      return {};
    }
  }

  /* 把任意回调包成「绝不抛到全局」 */
  function safe(fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        warn("handler failed: " + (err && err.message ? err.message : err));
        return undefined;
      }
    };
  }

  function warn(msg) {
    if (typeof console !== "undefined" && console.warn) {
      try { console.warn("[dsh-overlay] " + msg); } catch (e) { /* console 都没了就算了 */ }
    }
  }

  /* 状态信封归一化：未知字段忽略，缺失字段兜底（契约第 1 节，绝不许抛） */
  function normalizeState(raw) {
    var s = isPlainObject(raw) ? raw : {};
    var cfg = isPlainObject(s.cfg) ? s.cfg : {};
    var bubble = isPlainObject(s.bubble) ? s.bubble : null;
    return {
      v: s.v == null ? 1 : s.v,
      ts: typeof s.ts === "number" && isFinite(s.ts) ? s.ts : 0,
      src: typeof s.src === "string" ? s.src : "",
      emotion: typeof s.emotion === "string" ? s.emotion : "",
      emotionName: typeof s.emotionName === "string" ? s.emotionName : "",
      running: s.running === true,
      mood: typeof s.mood === "string" ? s.mood : "",
      taskMood: typeof s.taskMood === "string" ? s.taskMood : "",
      reason: typeof s.reason === "string" ? s.reason : "",
      bubble: bubble
        ? {
            text: typeof bubble.text === "string" ? bubble.text : "",
            source: typeof bubble.source === "string" ? bubble.source : "local",
            mood: typeof bubble.mood === "string" ? bubble.mood : "",
            seq: typeof bubble.seq === "number" && isFinite(bubble.seq) ? bubble.seq : 0
          }
        : null,
      pricing: isPlainObject(s.pricing) ? s.pricing : null,
      cfg: cfg
    };
  }

  /* 表情 ID 一律两位字符串；"0"→"00"，非法给空串 */
  function asEmotionId(v) {
    if (typeof v !== "string") return "";
    var id = trim(v);
    if (/^\d$/.test(id)) id = "0" + id;
    return /^\d{2}$/.test(id) ? id : "";
  }

  /* ============================ 上报 ============================ */

  function makePoster(getWin) {
    return function post(type, extra) {
      if (!type) return false;
      var payload = { type: type };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
        }
      }
      var json;
      try { json = JSON.stringify(payload); } catch (err) { return false; }
      var w = getWin ? getWin() : (typeof window !== "undefined" ? window : null);
      var host = w && w.DshOverlayHost;
      if (!host || typeof host.post !== "function") return false;
      try {
        host.post(json);
        return true;
      } catch (err) {
        return false;   /* 静默：宿主接口坏掉不能影响页面 */
      }
    };
  }

  /* ============================ 渲染调度器 ============================
   * 全页唯一 rAF：只有「需要重绘」时才连续跑帧；没有变化就立刻停。
   * 空闲时只有 1fps 心跳（setInterval），不空转重绘。
   */
  function createRenderLoop(env) {
    var clock = env.now || now;
    var rafFn = null;
    var running = false;
    var rafId = 0;
    function frame() {
      rafId = 0;
      try {
        if (rafFn) rafFn(clock());
      } catch (err) {
        warn("render frame failed: " + (err && err.message ? err.message : err));
      }
      if (running) rafId = env.requestFrame(frame);
    }
    return {
      setRenderer: function (fn) { if (typeof fn === "function") rafFn = fn; },
      isRunning: function () { return running; },
      start: function () {
        if (running) return false;
        running = true;
        rafId = env.requestFrame(frame);
        return true;
      },
      stop: function () {
        if (!running) return false;
        running = false;
        if (rafId) { env.cancelFrame(rafId); rafId = 0; }
        return true;
      }
    };
  }

  /* ============================ 手势状态机（纯逻辑，可单测） ============================
   * 规则（契约 4.3）：
   *   - 位移（|dx|+|dy|）> 8 逻辑 px => 判定拖动，取消 tap、取消长按
   *   - 按住 0.5s 未移动 => longPress，且本次手势不再产生 tap
   *   - 松手未移动、未长按 => tap
   */
  function createGestures(opts) {
    var o = opts || {};
    var onTap = o.onTap || function () {};
    var onLongPress = o.onLongPress || function () {};
    var onDragStart = o.onDragStart || function () {};
    var onDrag = o.onDrag || function () {};
    var onDragEnd = o.onDragEnd || function () {};
    var cbs = o.callbacks || {};
    var schedule = cbs.schedule || function (fn, ms) { return setTimeout(fn, ms); };
    var cancel = cbs.cancel || function (t) { clearTimeout(t); };
    var nowFn = o.now || now;
    var densityFn = o.density || density;
    var threshold = o.threshold == null ? DRAG_THRESHOLD : o.threshold;
    var holdMs = o.holdMs == null ? HOLD_MS : o.holdMs;
    var reportMinMs = o.reportMinMs == null ? REPORT_MIN_MS : o.reportMinMs;
    var reportDx = o.reportDx == null ? REPORT_DX : o.reportDx;

    var active = null;
    var holdTimer = null;
    var pendingDx = 0, pendingDy = 0;
    var lastFlushAt = 0;

    function clearHold() {
      if (holdTimer !== null) {
        cancel(holdTimer);
        holdTimer = null;
      }
    }

    function armHold() {
      clearHold();
      holdTimer = schedule(function () {
        holdTimer = null;
        if (!active || active.moved) return;   /* 已经在拖动就不算长按 */
        active.longPressed = true;
        onLongPress();
      }, holdMs);
    }

    function down(e) {
      if (!e || active) return false;
      if (e.button !== undefined && e.button !== 0) return false;
      active = {
        id: e.pointerId,
        x0: e.clientX, y0: e.clientY,
        x: e.clientX, y: e.clientY,
        t0: nowFn(),
        moved: false,
        longPressed: false
      };
      pendingDx = 0;
      pendingDy = 0;
      lastFlushAt = nowFn();
      armHold();
      return true;
    }

    function move(e) {
      if (!e || !active) return false;
      if (e.pointerId !== undefined && active.id !== undefined && e.pointerId !== active.id) return false;
      if (e.clientX === active.x && e.clientY === active.y) return false;
      var dx = e.clientX - active.x0;      /* 逻辑 px（CSS px） */
      var dy = e.clientY - active.y0;
      if (!active.moved) {
        if (Math.abs(dx) + Math.abs(dy) <= threshold) return false;
        active.moved = true;
        clearHold();                       /* 开始拖动 => tap 与长按都作废 */
        lastFlushAt = nowFn();
        onDragStart();
      }
      pendingDx += (e.clientX - active.x) * densityFn();
      pendingDy += (e.clientY - active.y) * densityFn();
      active.x = e.clientX;
      active.y = e.clientY;
      return true;
    }

    function up(e) {
      if (!active) return false;
      if (e && e.pointerId !== undefined && active.id !== undefined && e.pointerId !== active.id) return false;
      var g = active;
      active = null;
      clearHold();
      if (g.moved) {
        onDragEnd();
        return true;
      }
      if (g.longPressed) return true;      /* 长按过，不再 tap */
      onTap();
      return true;
    }

    function cancelGesture() {
      if (!active) return false;
      var g = active;
      active = null;
      clearHold();
      if (g.moved) onDragEnd();
      return true;
    }

    /* 拖动上报节流：累积 >= 8 逻辑 px，或距上次上报 >= 40ms */
    function flushDrag(force) {
      if (!pendingDx && !pendingDy) return false;
      var elapsed = nowFn() - lastFlushAt;
      if (force !== true && Math.abs(pendingDx) + Math.abs(pendingDy) < reportDx && elapsed < reportMinMs) return false;
      var dx = Math.round(pendingDx);
      var dy = Math.round(pendingDy);
      if (dx === 0 && dy === 0) {
        if (force !== true) return false;
        /* 强制上报时取整成 0 也发一条，保证 dragEnd 前的位置是新的 */
      }
      pendingDx -= dx;
      pendingDy -= dy;
      lastFlushAt = nowFn();
      onDrag(dx, dy);
      return true;
    }

    return {
      down: down,
      move: move,
      up: up,
      cancel: cancelGesture,
      flushDrag: flushDrag,
      isActive: function () { return !!active; },
      isDragging: function () { return !!(active && active.moved); },
      reset: function () { active = null; clearHold(); pendingDx = 0; pendingDy = 0; }
    };
  }

  /* ============================ 控制器（球页） ============================ */

  function createManager(base) {
    base = base || {};
    var w = base.win || (typeof window !== "undefined" ? window : {});
    var emotions = base.emotions || EMOTIONS;
    var mount = base.mount === undefined ? (typeof document !== "undefined" ? document.getElementById("dsh-ball") : null) : base.mount;
    var docNode = base.doc === undefined ? (typeof document !== "undefined" ? (document.getElementById("dsh-stage") || document.body) : null) : base.doc;
    var constants = base.constants || {};
    var parse = base.parseJson || parseJson;
    var normalize = base.normalizeState || normalizeState;
    var colorsFor = base.themeColors || themeColors;
    var post = makePoster(function () { return w; });

    var state = null;
    var hostInfo = null;
    var settings = { size: SIZE_DEFAULT, theme: "dark", gaze: true, bubble: true, opacity: 1.0, locked: false };
    var engine = null;
    var destroyed = false;
    var lastWantSay = "";
    var sizeReported = null;
    var styleOverride = null;
    var heartbeatTimer = null;
    var wakeUntil = 0;
    var WAKE_MS = 900;

    var clockNow = base.now || now;      /* 时钟可注入，测试里用虚拟时间 */

    var requestFrame = base.requestFrame || function (fn) {
      if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
      return setTimeout(function () { fn(now()); }, 16);
    };
    var cancelFrame = base.cancelFrame || function (id) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
      else clearTimeout(id);
    };
    var setIntervalFn = base.setInterval || function (fn, ms) { return setInterval(fn, ms); };
    var clearIntervalFn = base.clearInterval || function (t) { clearInterval(t); };

    /* 默认渲染方式：用本页唯一的 rAF 驱动引擎内部 tick，引擎自己不开循环 */
    function defaultRenderer(t) {
      if (!engine) return;
      if (styleOverride && typeof engine.setStyle === "function") {
        try { engine.setStyle(styleOverride); } catch (e) { /* ignore */ }
      }
      if (typeof engine._tick === "function") engine._tick(t);
    }
    var renderer = base.renderer || defaultRenderer;

    var loop = createRenderLoop({ requestFrame: requestFrame, cancelFrame: cancelFrame, now: clockNow });
    loop.setRenderer(renderer);

    function renderOnce() {
      try { renderer(clockNow()); } catch (err) { warn("render failed: " + (err && err.message ? err.message : err)); }
    }

    /* ---- rAF 唤醒预算：有动画就多跑一会儿，随后自动停 ---- */
    function wake(ms) {
      wakeUntil = Math.max(wakeUntil, clockNow() + (ms == null ? WAKE_MS : ms));
      if (!loop.isRunning()) loop.start();
    }
    function tickGuard() {
      if (clockNow() >= wakeUntil && loop.isRunning()) loop.stop();
    }

    /* ---- 引擎挂载：只挂一次，32 个表情在同一实例里切（不重建） ---- */
    function mountEngine() {
      if (engine || destroyed) return engine;
      try {
        var EB = w.EmotionBall || (typeof window !== "undefined" ? window.EmotionBall : null);
        if (!EB || typeof EB.create !== "function" || !mount) return null;
        var colors = colorsFor(settings.theme);
        engine = EB.create(mount, {
          emotion: pickEmotion(),
          color: colors.color,
          eyeColor: colors.eyeColor,
          label: "AI 表情球"
        });
        if (typeof engine.on === "function") {
          engine.on("error", function (ev) { warn("engine: " + (ev && ev.message ? ev.message : ev)); });
        }
        /* 引擎自带的 rAF 循环关掉：本页只允许一个 rAF */
        if (typeof engine.setActive === "function") engine.setActive(false);
        renderOnce();
      } catch (err) {
        engine = null;
        warn("engine create failed: " + (err && err.message ? err.message : err));
      }
      return engine;
    }

    function applyVisual() {
      var html = typeof document !== "undefined" ? document.documentElement : null;
      if (html && html.setAttribute) html.setAttribute("data-theme", settings.theme === "cream" ? "cream" : "dark");
      if (docNode && docNode.style) docNode.style.opacity = String(clamp(Number(settings.opacity) || 1, 0.2, 1));
    }

    /* ---- 尺寸：球窗就是 overlaySize 见方，球画满整窗 ---- */
    function measure() {
      var size = clamp(Number(settings.size) || (constants.sizeDefault || SIZE_DEFAULT), SIZE_MIN, SIZE_MAX);
      return { w: Math.round(size), h: Math.round(size) };
    }

    function reportSize(force) {
      var m = measure();
      if (!force && sizeReported && sizeReported.w === m.w && sizeReported.h === m.h) return false;
      sizeReported = m;
      post("size", { w: m.w, h: m.h });
      return true;
    }

    function fireReady() {
      var m = measure();
      reportSize(true);
      post("ready", { w: m.w, h: m.h });
    }

    /* ---- 表情：真实表情优先，未知/缺失回退待机 02 ---- */
    function pickEmotion() {
      var id = asEmotionId(state && state.emotion);
      if (!id || !isKnownEmotion(id)) id = asEmotionId(state && state.mood);
      if (!id || !isKnownEmotion(id)) id = "02";
      return id;
    }

    function applyEmotion() {
      var id = pickEmotion();
      if (engine) {
        try {
          if (engine.emotionId !== id && typeof engine.setEmotion === "function") engine.setEmotion(id);
          if (typeof engine.resetIdle === "function") engine.resetIdle();
        } catch (err) {
          warn("setEmotion failed: " + (err && err.message ? err.message : err));
        }
        renderOnce();
      }
      return id;
    }

    /* ---- 交互动作 ---- */
    function doSpin() {
      wake(1400);
      if (engine) {
        try {
          if (typeof engine.burst === "function") engine.burst(20);
          if (typeof engine.spin === "function") engine.spin(1);
          if (typeof engine.bounce === "function") engine.bounce();
          if (typeof engine.resetIdle === "function") engine.resetIdle();
        } catch (err) {
          warn("spin failed: " + (err && err.message ? err.message : err));
        }
        renderOnce();
      }
      tickGuard();
    }

    function sayLocal() {
      if (settings.bubble === false) return "";
      var text = localLine(pickEmotion());
      post("wantSay", { text: text });
      return text;
    }

    var gestures = createGestures({
      threshold: constants.dragThreshold,
      holdMs: constants.holdMs,
      now: base.now || now,
      callbacks: base.callbacks,
      density: density,
      onTap: function () {
        post("tap");
        doSpin();
        sayLocal();
        wake(700);
      },
      onLongPress: function () {
        wake(200);
        post("longPress");
        if (base.vibrate !== false && w.navigator && typeof w.navigator.vibrate === "function") {
          try { w.navigator.vibrate(18); } catch (e) { /* ignore */ }
        }
      },
      onDragStart: function () {
        if (docNode && docNode.setAttribute) docNode.setAttribute("data-dragging", "1");
        wake(400);
        post("dragStart");
      },
      onDrag: function (dx, dy) {
        wake(200);
        post("drag", { dx: dx, dy: dy });
      },
      onDragEnd: function () {
        if (docNode && docNode.setAttribute) docNode.setAttribute("data-dragging", "0");
        gestures.flushDrag(true);          /* 补发最后一段位移 */
        post("dragEnd");
        wake(300);
      }
    });

    /* ---- 页面入口：window.__dshOverlay.{state,host,settings,cmd} ---- */
    var api = {
      state: safe(function (json) {
        state = normalize(parse(json));
        var b = state.bubble;
        if (b && b.text && b.text !== lastWantSay) {
          lastWantSay = b.text;
          post("wantSay", { text: b.text });
        }
        applyEmotion();
        wake(700);
        return true;
      }),
      host: safe(function (json) {
        hostInfo = parse(json);
        if (hostInfo.overlay === false) { if (loop.isRunning()) loop.stop(); return false; }
        if (hostInfo.dsh === "down") return false;
        wake(700);
        return true;
      }),
      settings: safe(function (json) {
        var raw = parse(json);
        var next = {
          size: typeof raw.size === "number" && isFinite(raw.size) ? clamp(raw.size, SIZE_MIN, SIZE_MAX) : settings.size,
          theme: raw.theme === "cream" ? "cream" : (raw.theme === "dark" ? "dark" : settings.theme),
          gaze: raw.gaze === undefined ? settings.gaze : raw.gaze === true,
          bubble: raw.bubble === undefined ? settings.bubble : raw.bubble === true,
          opacity: typeof raw.opacity === "number" && isFinite(raw.opacity) ? clamp(raw.opacity, 0.2, 1) : settings.opacity,
          locked: raw.locked === true
        };
        var sizeChanged = next.size !== settings.size;
        settings = next;
        applyVisual();
        if (sizeChanged) reportSize(true);
        wake(300);
        return true;
      }),
      cmd: safe(function (json) {
        var c = parse(json);
        var name = typeof c.name === "string" ? c.name : "";
        var args = isPlainObject(c.args) ? c.args : {};
        if (name === "resync") {
          applyEmotion();
          reportSize(true);
          wake(700);
          return true;
        }
        if (name === "taunt") {
          wake(1200);
          post("taunt", { text: typeof args.text === "string" ? args.text : "" });
          return true;
        }
        if (name === "bye") {
          post("closed");
          stop();
          return true;
        }
        return false;
      }),
      ready: safe(function () { fireReady(); wake(900); return true; })
    };

    function start() {
      if (destroyed) return false;
      mountEngine();
      applyVisual();
      applyEmotion();
      fireReady();
      wake(WAKE_MS);
      if (heartbeatTimer === null) {
        heartbeatTimer = setIntervalFn(function () {
          if (destroyed) return;
          tickGuard();               /* 空闲到点就停 rAF（1fps 心跳只上报、不重绘） */
          reportSize(false);         /* 尺寸没变就不发，避免无谓 post */
        }, constants.heartbeatMs || HEARTBEAT_MS);
      }
      return true;
    }

    function stop() {
      destroyed = true;
      if (loop.isRunning()) loop.stop();
      if (heartbeatTimer !== null) { clearIntervalFn(heartbeatTimer); heartbeatTimer = null; }
    }

    function destroy() {
      stop();
      if (engine && typeof engine.destroy === "function") {
        try { engine.destroy(); } catch (e) { /* ignore */ }
      }
      engine = null;
    }

    Object.defineProperty(api, "engine", { get: function () { return engine; }, configurable: true });

    return {
      api: api,
      gestures: gestures,
      loop: loop,
      start: start,
      stop: stop,
      destroy: destroy,
      wake: wake,
      tickGuard: tickGuard,
      tick: function (t) { renderer(t === undefined ? clockNow() : t); tickGuard(); },
      measure: measure,
      renderOnce: renderOnce,
      getState: function () { return state; },
      getHost: function () { return hostInfo; },
      getSettings: function () { return settings; },
      getEngine: function () { return engine; },
      pickEmotion: pickEmotion,
      reportSize: reportSize
    };
  }

  /* ============================ 全局接线 ============================ */

  function install(env) {
    env = env || {};
    var w = env.win || (typeof window !== "undefined" ? window : {});
    var doc = env.doc !== undefined ? env.doc : (typeof document !== "undefined" ? document : null);
    var data = {
      win: w,
      doc: doc,
      mount: env.mount !== undefined ? env.mount : (doc ? doc.getElementById("dsh-ball") : null),
      emotions: env.emotions || EMOTIONS,
      parseJson: env.parseJson || parseJson,
      normalizeState: env.normalizeState || normalizeState,
      themeColors: env.themeColors || themeColors,
      requestFrame: env.requestFrame,
      cancelFrame: env.cancelFrame,
      setInterval: env.setInterval,
      clearInterval: env.clearInterval,
      renderer: env.renderer,
      callbacks: env.callbacks,
      now: env.now,
      vibrate: env.vibrate,
      autostart: env.autostart
    };
    var managers = createManager(data);

    /* App 调用的固定入口 */
    w.__dshOverlay = managers.api;
    w.__dshOverlayInternal = managers;

    if (env.autostart !== false) {
      if (doc && doc.readyState === "loading" && doc.addEventListener) {
        doc.addEventListener("DOMContentLoaded", function () { managers.start(); });
      } else {
        managers.start();
      }
    }
    return managers;
  }

  var PAGE = {
    EMOTIONS: EMOTIONS,
    DRAG_THRESHOLD: DRAG_THRESHOLD,
    HOLD_MS: HOLD_MS,
    REPORT_DX: REPORT_DX,
    REPORT_MIN_MS: REPORT_MIN_MS,
    HEARTBEAT_MS: HEARTBEAT_MS,
    SIZE_DEFAULT: SIZE_DEFAULT,
    THEMES: THEMES,
    bubbleTone: bubbleTone,
    emotionName: emotionName,
    themeColors: themeColors,
    parseJson: parseJson,
    normalizeState: normalizeState,
    asEmotionId: asEmotionId,
    isKnownEmotion: isKnownEmotion,
    localLine: localLine,
    createGestures: createGestures,
    createRenderLoop: createRenderLoop,
    createManager: createManager,
    install: install
  };

  if (typeof window !== "undefined") {
    window.__dshBallPage = PAGE;
    if (!window.__DSH_NO_AUTOSTART) install();
  }
})();
