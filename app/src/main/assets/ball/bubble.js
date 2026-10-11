/* ============================================================================
 * bubble.js — 悬浮窗「气泡页」逻辑（file:///android_asset/ball/bubble.html）
 *
 * v1 修订 A：气泡独立成窗（球窗会吃掉触摸，气泡不能和球挤在一个窗口里）。
 * 本页只负责：打字机 / 排队 / 续时 / 尖尖朝向 / 尺寸上报；位置由 App 算。
 *
 * 规则（和网页版 20-ball.js 逐条一致）：
 *   - 前置 600ms，逐字 42ms/字；文本 > 30 字时打字速度 ×0.6（≈25ms/字）
 *   - 阅读时长 = 65ms/字，最少 2.6s、最多 9s
 *   - 点一下续 5s，可连点
 *   - 队列上限 2：正在显示的不被顶掉，新话进队列；同 seq 忽略；满了丢最旧
 *   - 上报 bubbleSize 之前不显示（防闪）
 *
 * 对外入口：window.__dshOverlay.setup(json) / bubble(json) / done()
 * 上报：DshOverlayHost.post —— bubbleSize / bubbleDone / bubbleTap
 * ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------- 常量 ------------------------------- */

  var TYPE_MS = 42;              /* 逐字速度 */
  var TYPE_FAST_FACTOR = 0.6;    /* > 30 字加速 */
  var TYPE_LEAD_MS = 600;        /* 前置停顿 */
  var READ_PER_CHAR_MS = 65;     /* 阅读时长/字 */
  var READ_MIN_MS = 2600;
  var READ_MAX_MS = 9000;
  var LINGER_MS = 5000;          /* 点一下续 5 秒 */
  var QUEUE_MAX = 2;             /* 队列上限（丢最旧） */
  var LONG_TEXT = 30;            /* 超过这个字数就加速 */
  var TIP_GAP = 10;              /* 尖尖占位（逻辑 px，计入窗口高度） */

  var MAX_W_DEFAULT = 230;
  var MAX_W_MIN = 80;
  var MAX_W_MAX = 320;

  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isPlainObject(v) { return !!v && typeof v === "object" && !(v instanceof Array); }
  function trim(v) { return String(v == null ? "" : v).replace(/^\s+|\s+$/g, ""); }

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

  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); }
      catch (err) { warn("handler failed: " + (err && err.message ? err.message : err)); return undefined; }
    };
  }

  function warn(msg) {
    if (typeof console !== "undefined" && console.warn) {
      try { console.warn("[dsh-bubble] " + msg); } catch (e) { /* ignore */ }
    }
  }

  /* 气泡色调：和网页版 20-ball.js 的 bubbleTone 逐档一致 */
  var TONE_WARM = { "10": 1, "19": 1, "33": 1, "14": 1, "13": 1 };
  var TONE_BLUE = { "12": 1, "15": 1, "18": 1, "21": 1 };
  var TONE_ALERT = { "17": 1, "34": 1, "38": 1 };
  var TONE_WORK = { "30": 1, "16": 1, "32": 1, "40": 1, "31": 1, "37": 1 };
  function bubbleTone(moodId) {
    var id = trim(moodId);
    if (/^\d$/.test(id)) id = "0" + id;
    if (TONE_WARM[id]) return "warm";
    if (TONE_BLUE[id]) return "blue";
    if (TONE_ALERT[id]) return "alert";
    if (TONE_WORK[id]) return "work";
    return "plain";
  }

  /* --------------------------- 时长公式（可单测） --------------------------- */

  function typeSpeed(text) {
    var len = (text || "").length;
    return len > LONG_TEXT ? Math.round(TYPE_MS * TYPE_FAST_FACTOR) : TYPE_MS;
  }
  function readMs(text) {
    var len = (text || "").length;
    return clamp(len * READ_PER_CHAR_MS, READ_MIN_MS, READ_MAX_MS);
  }
  function totalMs(text, extraMs) {
    return TYPE_LEAD_MS + (text || "").length * typeSpeed(text) + readMs(text) + (extraMs || 0);
  }

  /* ------------------------------- 上报 ------------------------------- */

  function makePoster(getWin) {
    return function post(type, extra) {
      if (!type) return false;
      var payload = { type: type };
      if (extra) {
        for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
      }
      var json;
      try { json = JSON.stringify(payload); } catch (err) { return false; }
      var w = getWin ? getWin() : (typeof window !== "undefined" ? window : null);
      var host = w && w.DshOverlayHost;
      if (!host || typeof host.post !== "function") return false;
      try { host.post(json); return true; } catch (err) { return false; }
    };
  }

  /* ------------------------------- 核心 ------------------------------- */

  function createBubbleCore(opts) {
    var o = opts || {};
    var post = o.post || function () { return false; };
    var timers = o.timers || {
      after: function (fn, ms) { return setTimeout(fn, ms); },
      clear: function (h) { clearTimeout(h); },
      now: now
    };
    var measure = o.measure || function (text, setup) {
      var len = (text || "").length;
      var w = Math.min(setup.maxW, 40 + len * 13);
      var h = 20 + Math.ceil(len / 16) * 19;
      return { w: Math.ceil(w), h: Math.ceil(h) + TIP_GAP };
    };
    var onChange = o.onChange || function () {};

    var setup = { side: "top", tipX: 40, maxW: MAX_W_DEFAULT, theme: "dark" };
    var current = null;         /* { text, source, mood, seq, tone } */
    var queue = [];
    var extraMs = 0;
    var typed = 0;
    var lastSeq = null;
    var lastSize = null;
    var visible = false;
    var sizeSent = false;
    var doneTimer = null;
    var typeTimer = null;
    var leadTimer = null;

    function view(shownText) {
      return {
        visible: visible,
        text: shownText == null ? (current ? current.text.slice(0, typed) : "") : shownText,
        fullText: current ? current.text : "",
        side: setup.side,
        tipX: setup.tipX,
        maxW: setup.maxW,
        theme: setup.theme,
        tone: current ? current.tone : "plain",
        typing: !!current && typed < current.text.length
      };
    }

    function emit(shownText) {
      try { onChange(view(shownText)); } catch (err) { warn("onChange failed: " + err); }
    }

    function clearTimers() {
      if (doneTimer !== null) { timers.clear(doneTimer); doneTimer = null; }
      if (typeTimer !== null) { timers.clear(typeTimer); typeTimer = null; }
      if (leadTimer !== null) { timers.clear(leadTimer); leadTimer = null; }
    }

    /* 打字机：前置 600ms 后开始逐字，速度按文本长度决定 */
    function startTyping() {
      if (!current) return;
      var speed = typeSpeed(current.text);
      var step = function () {
        typeTimer = null;
        if (!current) return;
        typed = Math.min(typed + 1, current.text.length);
        emit();
        if (typed < current.text.length) typeTimer = timers.after(step, speed);
      };
      leadTimer = timers.after(function () {
        leadTimer = null;
        if (!current) return;
        visible = true;        /* 尺寸已上报，这里才允许显示 */
        typed = 1;
        emit();
        if (typed < current.text.length) typeTimer = timers.after(step, speed);
      }, TYPE_LEAD_MS);
    }

    function scheduleDone() {
      if (doneTimer !== null) { timers.clear(doneTimer); doneTimer = null; }
      if (!current) return;
      var wait = totalMs(current.text, extraMs);
      doneTimer = timers.after(function () {
        doneTimer = null;
        finishCurrent();
      }, wait);
    }

    /* 上报尺寸：必须在显示之前（防闪）；尺寸没变就不重复报 */
    function reportSize() {
      if (!current) return;
      var m;
      try { m = measure(current.text, setup) || {}; } catch (err) { m = {}; }
      var w = Math.max(1, Math.round(Number(m.w) || setup.maxW));
      var h = Math.max(1, Math.round(Number(m.h) || 44));
      if (!sizeSent || !lastSize || lastSize.w !== w || lastSize.h !== h) {
        lastSize = { w: w, h: h };
        sizeSent = true;
        post("bubbleSize", { w: w, h: h });
      } else {
        sizeSent = true;
      }
    }

    function show(entry) {
      current = entry;
      typed = 0;
      extraMs = 0;
      visible = false;       /* 先不显示：等 bubbleSize 报出去，防闪 */
      emit("");
      reportSize();
      startTyping();         /* 前置 600ms，第一个字出现时才显示 */
      scheduleDone();
    }

    function finishCurrent() {
      clearTimers();
      current = null;
      typed = 0;
      extraMs = 0;
      visible = false;
      emit("");
      var next = queue.shift() || null;
      if (next) {
        show(next);
        return false;
      }
      post("bubbleDone");
      return true;
    }

    function enqueue(entry) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].text === entry.text) return false;   /* 同一条不重复排 */
      }
      queue.push(entry);
      while (queue.length > QUEUE_MAX) queue.shift();      /* 满了丢最旧 */
      return true;
    }

    function normalizeBubble(raw) {
      var b = parseJson(raw);
      var text = typeof b.text === "string" ? b.text : "";
      if (!text) return null;
      return {
        text: text,
        source: typeof b.source === "string" ? b.source : "local",
        mood: typeof b.mood === "string" ? b.mood : "",
        seq: typeof b.seq === "number" && isFinite(b.seq) ? b.seq : null,
        tone: bubbleTone(typeof b.mood === "string" ? b.mood : "")
      };
    }

    var api = {
      setup: safe(function (json) {
        var raw = parseJson(json);
        setup = {
          side: raw.side === "bottom" ? "bottom" : "top",
          tipX: typeof raw.tipX === "number" && isFinite(raw.tipX) ? Math.round(raw.tipX) : setup.tipX,
          maxW: typeof raw.maxW === "number" && isFinite(raw.maxW) ? clamp(Math.round(raw.maxW), MAX_W_MIN, MAX_W_MAX) : setup.maxW,
          theme: raw.theme === "cream" ? "cream" : "dark"
        };
        lastSize = null;                 /* 布局变了，尺寸必须重报 */
        emit();
        return true;
      }),
      bubble: safe(function (json) {
        var entry = normalizeBubble(json);
        if (!entry) return false;
        if (entry.seq !== null && lastSeq !== null && entry.seq === lastSeq) return false;  /* 同 seq 忽略 */
        if (entry.seq !== null) lastSeq = entry.seq;
        if (current && current.text === entry.text) return false;   /* 正在说的就是这句，不重复 */
        if (current) return enqueue(entry);      /* 正在显示：排队，不打断 */
        show(entry);
        return true;
      }),
      done: safe(function () {
        /* App 说这轮结束了：清干净并回执，让 App 关窗 */
        clearTimers();
        current = null;
        queue = [];
        typed = 0;
        extraMs = 0;
        visible = false;
        emit("");
        post("bubbleDone");
        return true;
      }),
      /* 点一下：续 5 秒，可连点（不改打字进度、不清已显示的字） */
      tap: safe(function () {
        if (!current) return false;
        extraMs += LINGER_MS;
        scheduleDone();
        post("bubbleTap");
        return true;
      })
    };

    return {
      api: api,
      getSetup: function () { return setup; },
      getCurrent: function () { return current; },
      getQueue: function () { return queue.slice(); },
      getExtraMs: function () { return extraMs; },
      getTyped: function () { return typed; },
      isVisible: function () { return visible; },
      lastSize: function () { return lastSize; },
      finishCurrent: finishCurrent
    };
  }

  /* --------------------------- 页面接线（DOM） --------------------------- */

  function install(env) {
    env = env || {};
    var w = env.win || (typeof window !== "undefined" ? window : {});
    var doc = env.doc !== undefined ? env.doc : (typeof document !== "undefined" ? document : null);
    var el = env.el !== undefined ? env.el : (doc ? doc.getElementById("dsh-bubble") : null);
    var post = env.post || makePoster(function () { return w; });
    var realTimers = env.timers || {
      after: function (fn, ms) { return setTimeout(fn, ms); },
      clear: function (h) { clearTimeout(h); },
      now: now
    };

    function measure(text, setup) {
      if (!el) {
        var len = (text || "").length;
        return { w: Math.min(setup.maxW, 40 + len * 13), h: 20 + Math.ceil(len / 16) * 19 + TIP_GAP };
      }
      el.style.maxWidth = setup.maxW + "px";
      el.textContent = text;
      var cw = el.offsetWidth || el.clientWidth || setup.maxW;
      var ch = el.offsetHeight || el.clientHeight || 44;
      if (el.style) el.style.minHeight = ch + "px";   /* 打字过程中高度不抖 */
      return { w: cw, h: ch + TIP_GAP };   /* 多留 10px 给尖尖，窗口正好装得下 */
    }

    function onChange(view) {
      if (doc && doc.documentElement && doc.documentElement.setAttribute) {
        doc.documentElement.setAttribute("data-theme", view.theme === "cream" ? "cream" : "dark");
      }
      if (!el) return;
      el.textContent = view.text;
      if (el.setAttribute) {
        el.setAttribute("data-side", view.side);
        el.setAttribute("data-tone", view.tone);
        el.setAttribute("data-shown", view.visible ? "1" : "0");   /* 报尺寸前不显示 */
      }
      if (el.style && el.style.setProperty) el.style.setProperty("--dsh-tip-x", view.tipX + "px");
    }

    var core = createBubbleCore({ post: post, timers: realTimers, measure: measure, onChange: onChange });
    w.__dshOverlay = core.api;
    w.__dshBubbleInternal = core;

    /* 气泡页不可触摸，但真被点到（调试/降级）时也算一次续时 */
    if (el && el.addEventListener) {
      el.addEventListener("click", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        core.api.tap();
      });
      el.addEventListener("contextmenu", function (e) { if (e && e.preventDefault) e.preventDefault(); });
    }

    onChange({
      visible: false, text: "", side: "top", tipX: 40,
      maxW: MAX_W_DEFAULT, theme: "dark", tone: "plain", typing: false
    });
    return core;
  }

  var PAGE = {
    TYPE_MS: TYPE_MS,
    TYPE_LEAD_MS: TYPE_LEAD_MS,
    READ_PER_CHAR_MS: READ_PER_CHAR_MS,
    READ_MIN_MS: READ_MIN_MS,
    READ_MAX_MS: READ_MAX_MS,
    LINGER_MS: LINGER_MS,
    QUEUE_MAX: QUEUE_MAX,
    TIP_GAP: TIP_GAP,
    typeSpeed: typeSpeed,
    readMs: readMs,
    totalMs: totalMs,
    bubbleTone: bubbleTone,
    parseJson: parseJson,
    createBubbleCore: createBubbleCore,
    install: install
  };

  if (typeof window !== "undefined") {
    window.__dshBubblePage = PAGE;
    if (!window.__DSH_NO_AUTOSTART) install();
  }
})();
