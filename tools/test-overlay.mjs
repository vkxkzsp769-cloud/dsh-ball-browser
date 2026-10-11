#!/usr/bin/env node
/* ============================================================================
 * test-overlay.mjs — 悬浮窗前端自测（node 直接跑，零依赖）
 *
 *   node tools/test-overlay.mjs
 *
 * jsdom 是可选增强：装了就跑「真引擎 + 真 DOM」的端到端用例，
 * 没装就只跑纯逻辑用例（本轮计时器/手势状态机/契约表/静态检查），并打印跳过原因。
 *   npm i jsdom            （或用 NODE_PATH 指向已装的 node_modules）
 *
 * 覆盖（与 task-1 验收标准逐条对应）：
 *   1  32 表情 ID 唯一/齐全/名字与契约一致
 *   2  BallState 解析容错（空串/坏 JSON/null/类型错/缺字段）
 *   3  四个入口对非法入参不抛（__dshOverlay.state/host/settings/cmd）
 *   4  气泡时长公式（42ms/字、>30 字 ×0.6、65ms/字、2.6s~9s）
 *   5  气泡打字机 / 点一下续 5s（可连点）/ 读完回执 / done()
 *   6  气泡排队：上限 2、不顶掉正在显示的、同 seq 忽略、满了丢最旧
 *   7  气泡先报 bubbleSize 再显示；setup 的 side/tipX 透传
 *   8  拖动阈值：位移 <= 8 逻辑 px 算 tap，> 8 取消 tap 并走 drag*
 *   9  长按 0.5s 与单击不打架（长按后不再 tap）
 *   10 静态检查：零外链/零 CDN、引用的文件都在、禁选中/禁长按菜单样式
 *   11 上报类型齐全（ready/size/dragStart/drag/dragEnd/tap/longPress/taunt/wantSay/closed）
 *   12 jsdom：32 个表情全部被引擎接受（同一个实例切换，不重建）
 *   13 jsdom：全页只有一个 rAF，空闲到点就停（1fps 心跳，不空转重绘）
 *   14 jsdom：真实 DOM 指针事件走完 tap / 长按 / 拖动三条路
 *   15 jsdom：console 之外不发网络请求（fetch/XHR/sendBeacon 计数为 0）
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BALL_DIR = path.join(ROOT, "app/src/main/assets/ball");

/* ------------------------------ 迷你测试框架 ------------------------------ */

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "值不相等"}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "结构不相等"}：期望 ${b}，实际 ${a}`);
}
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`  - ${name}（跳过：${why}）`);
}
function section(title) { console.log(`\n${title}`); }

/* ------------------------------ 加载被测代码 ------------------------------ */

function readOrDie(p) {
  if (!fs.existsSync(p)) throw new Error(`缺少文件：${p}`);
  return fs.readFileSync(p, "utf8");
}

const SRC = {
  ball: readOrDie(path.join(BALL_DIR, "ball.js")),
  bubble: readOrDie(path.join(BALL_DIR, "bubble.js")),
  engine: readOrDie(path.join(BALL_DIR, "engine.js")),
  css: readOrDie(path.join(BALL_DIR, "style.css")),
  indexHtml: readOrDie(path.join(BALL_DIR, "index.html")),
  bubbleHtml: readOrDie(path.join(BALL_DIR, "bubble.html"))
};

/* 在纯 node 里求值页面脚本：给一个最小的 window/document 桩，只为拿到对外工厂 */
function evalWithStub(src, extraWindow) {
  const win = Object.assign({
    console,
    performance: typeof performance !== "undefined" ? performance : { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval
  }, extraWindow || {});
  win.window = win;
  win.document = undefined;
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", "performance", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", src);
  fn(win, undefined, win.performance, console, setTimeout, clearTimeout, setInterval, clearInterval);
  return win;
}

const ballWin = evalWithStub(SRC.ball, { __DSH_NO_AUTOSTART: true });
const bubbleWin = evalWithStub(SRC.bubble, { __DSH_NO_AUTOSTART: true });
const BallPage = ballWin.__dshBallPage;
const BubblePage = bubbleWin.__dshBubblePage;
ok(BallPage && BubblePage, "页面脚本没导出 __dshBallPage / __dshBubblePage");

/* ------------------------------ 虚拟时钟 ------------------------------ */

function virtualClock() {
  const c = { t: 0, seq: 0, timers: new Map() };
  return {
    now: () => c.t,
    after(fn, ms) { const id = ++c.seq; c.timers.set(id, { at: c.t + ms, fn }); return id; },
    clear(id) { c.timers.delete(id); },
    pending: () => c.timers.size,
    advance(ms) {
      const end = c.t + ms;
      let guard = 0;
      for (;;) {
        let next = null;
        for (const [id, timer] of c.timers) {
          if (timer.at <= end && (!next || timer.at < next.at)) next = { id, at: timer.at, fn: timer.fn };
        }
        if (!next) break;
        c.timers.delete(next.id);
        c.t = next.at;
        next.fn();
        if (++guard > 20000) throw new Error("定时器死循环");
      }
      c.t = end;
    }
  };
}

/* ============================================================================
 * 1. 32 个表情 ID
 * ========================================================================== */

const CONTRACT_EMOTIONS = (() => {
  const groups = [
    "00睡眠 01唤醒 02待机放空 03好奇 04发呆 05加载苏醒 06休眠 07抖动唤醒",
    "10开心 11疑惑 12失落 13惊讶 14害羞 15疲惫 16专注 17慌张 18无奈 19满意 20困惑 21生气",
    "30思考中 31接收任务 32处理中忙碌 33任务完成 34出错 35等待输入 36联网加载",
    "37复述回忆 38拒绝受限 39输出回复 40检索资料 41停止终止"
  ];
  return groups.join(" ").split(/\s+/).map((tok) => ({ id: tok.slice(0, 2), name: tok.slice(2) }));
})();

section("1. 表情表（32 个，ID/名字对齐契约第 2 节）");

test("ID 全局唯一且一个不落", () => {
  const ids = BallPage.EMOTIONS.map((e) => e.id);
  eq(ids.length, 32, "表情数量");
  eq(new Set(ids).size, 32, "ID 去重后数量");
  deepEq([...ids].sort(), CONTRACT_EMOTIONS.map((e) => e.id).sort(), "ID 集合");
});

test("每个 ID 都是两位字符串（不是数字类型）", () => {
  for (const e of BallPage.EMOTIONS) {
    eq(typeof e.id, "string", `${e.id} 类型`);
    ok(/^\d{2}$/.test(e.id), `${e.id} 形状`);
  }
});

test("名字与契约逐字相同", () => {
  for (const want of CONTRACT_EMOTIONS) {
    eq(BallPage.emotionName(want.id), want.name, `${want.id} 名字`);
  }
});

test("bubbleTone 与网页版 20-ball.js 同档", () => {
  eq(BallPage.bubbleTone("10"), "warm");
  eq(BallPage.bubbleTone("13"), "warm");
  eq(BallPage.bubbleTone("12"), "blue");
  eq(BallPage.bubbleTone("21"), "blue");
  eq(BallPage.bubbleTone("17"), "alert");
  eq(BallPage.bubbleTone("30"), "work");
  eq(BallPage.bubbleTone("37"), "work");
  eq(BallPage.bubbleTone("02"), "plain");
  eq(BallPage.bubbleTone("1"), "plain", "单个数字补零成 01：生命周期，落在 plain");
  eq(BallPage.bubbleTone(10), "warm", "数字 10 也认");
  eq(BallPage.bubbleTone(null), "plain");
});

/* ============================================================================
 * 2/3. 状态解析与入口容错
 * ========================================================================== */

section("2/3. BallState 解析容错 + 四个入口不抛");

test("坏输入一律给安全默认值，不抛", () => {
  const inputs = ["", "{", "null", "undefined", "[]", "123", '"str"', "{\"v\":null}", null, undefined, NaN, 42, true];
  for (const raw of inputs) {
    const s = BallPage.parseJson(raw);
    ok(s && typeof s === "object" && !Array.isArray(s), `parseJson(${String(raw)}) 应返回对象`);
    const n = BallPage.normalizeState(s);
    eq(n.v, 1, "v 兜底");
    eq(n.ts, 0, "ts 兜底");
    eq(n.emotion, "", "emotion 兜底");
    eq(n.running, false, "running 兜底");
    eq(n.bubble, null, "bubble 兜底");
  }
});

test("缺字段 / 类型错 / 未知字段：忽略或兜底", () => {
  const n = BallPage.normalizeState({
    emotion: 30, mood: null, running: "yes", bubble: "nope",
    cfg: null, pricing: [], reason: 5, unknownField: { a: 1 }
  });
  eq(n.emotion, "", "数字 emotion 视为缺失");
  eq(n.mood, "", "null mood 兜底");
  eq(n.running, false, "字符串 running 不认");
  eq(n.bubble, null, "非对象 bubble 兜底");
  eq(n.reason, "", "数字 reason 兜底");
  ok(!("unknownField" in n), "未知字段不进入归一化结果");
});

test("合法状态原样保留（含 bubble 子字段）", () => {
  const n = BallPage.normalizeState({
    v: 1, ts: 1730000000000, src: "web", emotion: "32", running: true,
    bubble: { text: "在跑", source: "ai", mood: "30", seq: 7 },
    cfg: { size: 96, theme: "cream" }
  });
  eq(n.v, 1); eq(n.ts, 1730000000000); eq(n.emotion, "32"); eq(n.running, true);
  deepEq(n.bubble, { text: "在跑", source: "ai", mood: "30", seq: 7 });
  eq(n.cfg.theme, "cream");
});

test("表情 ID 归一化：单个数字补零，非法给空串", () => {
  eq(BallPage.asEmotionId("0"), "00");
  eq(BallPage.asEmotionId(" 41 "), "41");
  eq(BallPage.asEmotionId(30), "");
  eq(BallPage.asEmotionId("abc"), "");
  eq(BallPage.asEmotionId("123"), "");
  eq(BallPage.asEmotionId(null), "");
});

test("四个入口吞掉非法 JSON（宿主不存在也不抛）", () => {
  const managers = BallPage.createManager({
    win: {}, doc: null, mount: null,
    requestFrame: () => 1, cancelFrame: () => {}, setInterval: () => 1, clearInterval: () => {}
  });
  const api = managers.api;
  const bads = ["", "{", "null", "[1,2]", '"x"', null, undefined, 42, NaN, true];
  for (const b of bads) {
    api.state(b); api.host(b); api.settings(b); api.cmd(b);
  }
  api.state('{"emotion":"ZZ","bubble":{"text":null,"seq":"9"}}');
  api.cmd('{"name":42,"args":[]}');
  api.settings('{"size":"big","theme":7,"opacity":null}');
  api.host('{"overlay":false}');
  ok(true, "没有任何异常抛出");
});

/* ============================================================================
 * 4/5/6/7. 气泡
 * ========================================================================== */

section("4. 气泡时长公式（对齐网页版 20-ball.js）");

test("逐字 42ms、>30 字 ×0.6、前置 600ms、阅读 65ms/字（2.6s~9s）", () => {
  eq(BubblePage.TYPE_MS, 42);
  eq(BubblePage.TYPE_LEAD_MS, 600);
  eq(BubblePage.READ_PER_CHAR_MS, 65);
  eq(BubblePage.READ_MIN_MS, 2600);
  eq(BubblePage.READ_MAX_MS, 9000);
  eq(BubblePage.LINGER_MS, 5000);
  eq(BubblePage.QUEUE_MAX, 2);

  eq(BubblePage.typeSpeed("短句"), 42);
  eq(BubblePage.typeSpeed("x".repeat(30)), 42, "30 字不加速");
  eq(BubblePage.typeSpeed("x".repeat(31)), 25, "31 字开始加速（42×0.6≈25）");

  eq(BubblePage.readMs("短"), 2600, "阅读最少 2.6s");
  eq(BubblePage.readMs("字".repeat(40)), 2600, "40×65=2600 刚好");
  eq(BubblePage.readMs("字".repeat(100)), 6500);
  eq(BubblePage.readMs("字".repeat(200)), 9000, "阅读最多 9s");

  // 10 字：600 + 420 + 2600 = 3620
  eq(BubblePage.totalMs("字".repeat(10)), 3620);
  // 50 字：600 + 50×25 + 3250 = 5100
  eq(BubblePage.totalMs("字".repeat(50)), 5100, "长句加速后总时长");
  // 点一次续 5s
  eq(BubblePage.totalMs("字".repeat(10), 5000), 8620);
});

section("5/6/7. 气泡打字 / 续时 / 排队 / 先报尺寸");

function newBubbleCore() {
  const clock = virtualClock();
  const posts = [];
  const views = [];
  const core = BubblePage.createBubbleCore({
    post: (type, extra) => posts.push(Object.assign({ type }, extra || {})),
    timers: { after: clock.after, clear: clock.clear, now: clock.now },
    measure: (text, setup) => ({ w: Math.min(setup.maxW, 24 + text.length * 12, ), h: 20 + Math.ceil(text.length / 16) * 19 + BubblePage.TIP_GAP }),
    onChange: (v) => views.push(v)
  });
  return { clock, posts, views, core, api: core.api, types: () => posts.map((p) => p.type) };
}

test("打字机：600ms 前置 + 42ms/字；读完 bubbleDone（队列空）", () => {
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text: "你好世界", seq: 1 }));
  eq(b.core.getTyped(), 0, "前置时间内一个字都没出");
  b.clock.advance(599);
  eq(b.core.getTyped(), 0, "599ms 还没打");
  b.clock.advance(1);
  eq(b.core.getTyped(), 1, "600ms 出第一个字");
  b.clock.advance(42 * 3);
  eq(b.core.getTyped(), 4, "42ms/字");
  ok(b.types().includes("bubbleDone") === false, "还没读完不该回执");
  b.clock.advance(BubblePage.totalMs("你好世界") - 600 - 42 * 3 + 10);
  eq(b.core.getCurrent(), null, "读完当前条已收起");
  eq(b.types().filter((t) => t === "bubbleDone").length, 1, "队列空了回一条 bubbleDone");
});

test("长句加速：31 字用 25ms/字", () => {
  const text = "词".repeat(31);
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text, seq: 1 }));
  b.clock.advance(600 + 25 * 4);
  eq(b.core.getTyped(), 5, "长句 25ms 出第 5 个字");
});

test("点一下续 5s，可连点；不重置打字进度", () => {
  const b = newBubbleCore();
  const text = "字".repeat(15);
  const base = BubblePage.totalMs(text);
  b.api.bubble(JSON.stringify({ text, seq: 1 }));
  b.clock.advance(base - 100);                 // 差 100ms 就该收了
  eq(b.core.getTyped(), 15, "打字已经打完");
  b.api.tap();
  eq(b.core.getExtraMs(), 5000, "续了 5s");
  eq(b.types().filter((t) => t === "bubbleTap").length, 1, "tap 上报");
  eq(b.core.getTyped(), 15, "续时不重置打字进度");
  b.clock.advance(4900);
  ok(b.core.getCurrent() !== null, "续时后还在显示");
  b.api.tap();
  eq(b.core.getExtraMs(), 10000, "可连点");
  b.clock.advance(base + 10000 - 1);
  ok(b.core.getCurrent() !== null, "两次续时还没用完");
  b.clock.advance(2);
  ok(b.core.getCurrent() === null, "两次续时用完后收起");
});

test("队列上限 2、不顶掉正在显示的、丢最旧", () => {
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text: "第一条", seq: 1 }));
  ok(b.core.getCurrent() !== null, "第一条立刻显示");
  b.api.bubble(JSON.stringify({ text: "第二条", seq: 2 }));
  b.api.bubble(JSON.stringify({ text: "第三条", seq: 3 }));
  b.api.bubble(JSON.stringify({ text: "第四条", seq: 4 }));
  deepEq(b.core.getQueue().map((q) => q.text), ["第三条", "第四条"], "满了丢最旧，队列最多 2 条");
  eq(b.core.getCurrent().text, "第一条", "正在显示的不被顶掉");
  b.clock.advance(BubblePage.totalMs("第一条") + 5);
  eq(b.core.getCurrent().text, "第三条", "读完自动上第二条（先排先出）");
  b.clock.advance(BubblePage.totalMs("第三条") + 5);
  eq(b.core.getCurrent().text, "第四条");
  b.clock.advance(BubblePage.totalMs("第四条") + 5);
  eq(b.core.getCurrent(), null);
  eq(b.types().filter((t) => t === "bubbleDone").length, 1, "全部读完后只回执一次");
});

test("同 seq 忽略、同文本不重复排队、坏输入不抛", () => {
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text: "只有一条", seq: 9 }));
  b.api.bubble(JSON.stringify({ text: "只有一条", seq: 9 }));
  eq(b.core.getQueue().length, 0, "同 seq 直接忽略");
  b.api.bubble(JSON.stringify({ text: "只有一条", seq: 10 }));
  eq(b.core.getQueue().length, 0, "同文本不重复排队");
  for (const bad of ["", "{", "null", "[]", '{"text":null}', '{"text":""}', null, 7]) {
    b.api.bubble(bad);
  }
  eq(b.core.getCurrent().text, "只有一条");
  eq(b.core.getQueue().length, 0);
});

test("先报 bubbleSize 再显示；显隐状态跟得上", () => {
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text: "先报尺寸", seq: 1 }));
  eq(b.types()[0], "bubbleSize", "第一条上报必须是尺寸");
  ok(b.core.lastSize() && b.core.lastSize().w > 0 && b.core.lastSize().h > 0, "尺寸有效");
  eq(b.core.isVisible(), false, "报尺寸这一刻还不能显示");
  eq(b.views[b.views.length - 1].visible, false, "视图此时不可见（防闪）");
  b.clock.advance(600);
  eq(b.core.isVisible(), true, "开始打字就显示");
  eq(b.views.filter((v) => v.visible && v.text.length > 0).length > 0, true, "有可见且带字的视图");
});

test("setup 透传 side / tipX / maxW / theme，坏值兜底", () => {
  const b = newBubbleCore();
  b.api.setup(JSON.stringify({ side: "bottom", tipX: 40, maxW: 200, theme: "cream" }));
  deepEq(b.core.getSetup(), { side: "bottom", tipX: 40, maxW: 200, theme: "cream" });
  b.api.setup('{"side":7,"tipX":"x","maxW":null,"theme":[]}');
  deepEq(b.core.getSetup(), { side: "top", tipX: 40, maxW: 200, theme: "dark" }, "非法值保持上一次");
  b.clock.advance(1);
  const v = b.views[b.views.length - 1];
  eq(v.side, "top");
  eq(v.tipX, 40);
});

test("done() 清干净并回执 bubbleDone", () => {
  const b = newBubbleCore();
  b.api.bubble(JSON.stringify({ text: "第一条", seq: 1 }));
  b.api.bubble(JSON.stringify({ text: "第二条", seq: 2 }));
  b.api.done();
  eq(b.core.getCurrent(), null);
  eq(b.core.getQueue().length, 0);
  eq(b.core.isVisible(), false);
  eq(b.types().filter((t) => t === "bubbleDone").length, 1);
  b.clock.advance(60000);
  eq(b.types().filter((t) => t === "bubbleDone").length, 1, "收起后不再重复回执");
});

/* ============================================================================
 * 8/9. 手势
 * ========================================================================== */

section("8/9. 手势：拖动阈值 / 长按与单击不打架");

function newGestureSpy(extra) {
  const clock = virtualClock();
  const events = [];
  const g = BallPage.createGestures(Object.assign({
    callbacks: { schedule: clock.after, cancel: clock.clear },
    now: clock.now,
    density: () => 1
  }, extra || {}, {
    onTap: () => events.push("tap"),
    onLongPress: () => events.push("longPress"),
    onDragStart: () => events.push("dragStart"),
    onDrag: (dx, dy) => events.push(`drag:${dx},${dy}`),
    onDragEnd: () => events.push("dragEnd")
  }));
  return { clock, events, g, types: () => events.map((e) => e.split(":")[0]) };
}

test("位移恰好 8 逻辑 px 仍是 tap（>8 才取消）", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  s.g.move({ pointerId: 1, clientX: 108, clientY: 100 });
  eq(s.g.isDragging(), false, "8px 内不判拖动");
  s.g.up({ pointerId: 1, clientX: 108, clientY: 100 });
  deepEq(s.events, ["tap"], "8px 松手还是单击");
});

test("位移 > 8 逻辑 px：取消 tap，改走 dragStart/drag/dragEnd", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  s.g.move({ pointerId: 1, clientX: 109, clientY: 100 });
  eq(s.g.isDragging(), true);
  eq(s.types().includes("tap"), false, "还没松手但 tap 已经没机会了");
  s.g.flushDrag(true);
  s.g.up({ pointerId: 1, clientX: 109, clientY: 100 });
  s.clock.advance(600);
  eq(s.types()[0], "dragStart");
  eq(s.types().includes("tap"), false, "拖动过就绝不产生 tap");
  eq(s.types().includes("longPress"), false, "拖动过也不产生长按");
  eq(s.types()[s.types().length - 1], "dragEnd");
});

test("drag 上报走节流：小碎步不刷屏，凑够 8 逻辑 px 才发", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
  s.g.move({ pointerId: 1, clientX: 6, clientY: 0 });    // 还没到拖动阈值
  eq(s.g.flushDrag(false), false, "还没判定拖动：没有位移可发");
  s.g.move({ pointerId: 1, clientX: 10, clientY: 0 });   // 越过阈值：dragStart，先攒 4px
  eq(s.g.flushDrag(false), false, "只攒到 4px 且不到 40ms：先攒着");
  s.g.move({ pointerId: 1, clientX: 14, clientY: 0 });   // 攒到 8px
  eq(s.g.flushDrag(false), true, "累积到 8 就发一条");
  deepEq(s.events.filter((e) => e.startsWith("drag:")), ["drag:8,0"]);
});

test("拖动久了即使位移小也按时上报（40ms 节流）", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
  s.g.move({ pointerId: 1, clientX: 12, clientY: 0 });
  s.g.flushDrag(false);
  s.g.move({ pointerId: 1, clientX: 14, clientY: 0 });   // 只走了 2px
  eq(s.g.flushDrag(false), false, "小碎步先攒着");
  s.clock.advance(40);
  eq(s.g.flushDrag(false), true, "到 40ms 就补一条");
  deepEq(s.events.filter((e) => e.startsWith("drag:")), ["drag:12,0", "drag:2,0"]);
});

test("density 缩放：位移按物理 px 上报（App 用 dp 开窗）", () => {
  const s = newGestureSpy({ density: () => 2.75 });
  s.g.down({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
  s.g.move({ pointerId: 1, clientX: 10, clientY: 0 });   // 10 逻辑 px → 27.5 物理 px
  eq(s.g.flushDrag(false), true);
  deepEq(s.events.filter((e) => e.startsWith("drag:")), ["drag:28,0"]);
});

test("长按 0.5s 触发 longPress，松手不再 tap", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  s.clock.advance(499);
  deepEq(s.events, [], "499ms 还什么都没发生");
  s.clock.advance(1);
  deepEq(s.events, ["longPress"], "500ms 触发长按");
  s.g.up({ pointerId: 1, clientX: 100, clientY: 100 });
  deepEq(s.events, ["longPress"], "长按后的松手不再产生 tap");
});

test("未到 0.5s 就松手 = 单击（长按定时器被清掉）", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 10, clientY: 10, button: 0 });
  s.clock.advance(200);
  s.g.up({ pointerId: 1, clientX: 10, clientY: 10 });
  deepEq(s.events, ["tap"]);
  s.clock.advance(5000);
  deepEq(s.events, ["tap"], "定时器没留下来补一发 longPress");
  eq(s.clock.pending(), 0, "没有残留定时器");
});

test("拖动判定会掐掉长按；非主键/重复按下被忽略", () => {
  const s = newGestureSpy();
  s.g.down({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
  s.g.down({ pointerId: 2, clientX: 0, clientY: 0, button: 0 });
  eq(s.g.isActive(), true, "第二次按下被忽略");
  s.g.move({ pointerId: 1, clientX: 20, clientY: 0 });
  s.clock.advance(2000);
  eq(s.types().includes("longPress"), false, "拖动中不触发长按");
  s.g.up({ pointerId: 3, clientX: 20, clientY: 0 });
  eq(s.g.isActive(), true, "别的 pointerId 松手不算结束");
  s.g.up({ pointerId: 1, clientX: 20, clientY: 0 });
  eq(s.g.isActive(), false);
});

/* ============================================================================
 * 10/11. 静态检查与上报契约
 * ========================================================================== */

section("10. 静态检查：零外链 / 文件齐全 / 禁选中");

function externalRefs(html) {
  const out = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

test("两个页面都没有外链/CDN（只有同目录本地文件）", () => {
  for (const [name, html] of [["index.html", SRC.indexHtml], ["bubble.html", SRC.bubbleHtml]]) {
    const refs = externalRefs(html);
    ok(refs.length > 0, `${name} 应该引用本地资源`);
    for (const ref of refs) {
      ok(!/:\/\//.test(ref), `${name} 出现外链：${ref}`);
      ok(!ref.startsWith("//"), `${name} 出现协议相对外链：${ref}`);
      ok(!/^(https?|ftp|ws)/i.test(ref), `${name} 出现远程地址：${ref}`);
      ok(!/"/.test(ref) && !/^data:/i.test(ref) || /^data:/.test(ref), `${name} 可疑引用：${ref}`);
    }
  }
});

test("页面引用的文件都真实存在（style.css / ball.js / engine.js / bubble.js）", () => {
  for (const html of [SRC.indexHtml, SRC.bubbleHtml]) {
    for (const ref of externalRefs(html)) {
      if (/^data:/.test(ref)) continue;
      const p = path.join(BALL_DIR, ref.replace(/^\.\//, ""));
      ok(fs.existsSync(p), `缺少被引用文件：${ref}`);
    }
  }
});

test("index.html 引 ball.js + engine.js；bubble.html 只引 bubble.js", () => {
  ok(SRC.indexHtml.includes("ball.js") && SRC.indexHtml.includes("engine.js"));
  ok(SRC.bubbleHtml.includes("bubble.js"));
  ok(!SRC.bubbleHtml.includes("engine.js"), "气泡窗不挂引擎（省内存）");
  ok(SRC.indexHtml.includes("style.css") && SRC.bubbleHtml.includes("style.css"), "共用样式");
});

test("样式里有禁选中 / 禁长按菜单 / touch-action:none / overflow:hidden", () => {
  ok(/user-select:\s*none/.test(SRC.css), "user-select:none");
  ok(/-webkit-user-select:\s*none/.test(SRC.css), "-webkit-user-select:none");
  ok(/-webkit-touch-callout:\s*none/.test(SRC.css), "-webkit-touch-callout:none");
  ok(/touch-action:\s*none/.test(SRC.css), "touch-action:none");
  ok(/overflow:\s*hidden/.test(SRC.css), "特效必须裁在窗口内");
  ok(/visibility:\s*hidden/.test(SRC.css), "气泡上报尺寸前不显示");
});

test("两个页面都声明 UTF-8 且没有远程脚本", () => {
  for (const html of [SRC.indexHtml, SRC.bubbleHtml]) {
    ok(/charset=["']?utf-8/i.test(html), "缺 charset");
    ok(!/<script[^>]+src=["']https?:/i.test(html), "远程脚本");
  }
});

test("源码里没有网络 API（fetch/XHR/WebSocket/beacon/import）", () => {
  for (const src of [SRC.ball, SRC.bubble]) {
    ok(!/\bfetch\s*\(/.test(src), "出现 fetch(");
    ok(!/XMLHttpRequest/.test(src), "出现 XMLHttpRequest");
    ok(!/new\s+WebSocket/.test(src), "出现 WebSocket");
    ok(!/navigator\.sendBeacon/.test(src), "出现 sendBeacon");
    ok(!/import\s*\(/.test(src), "出现动态 import");
    ok(!/https?:\/\//.test(src.replace(/https?:\/\/www\.w3\.org[^\s"']*/g, "")), "出现 http(s) 地址");
  }
  const engineNet = SRC.engine.match(/https?:\/\/(?!www\.w3\.org)[^\s"')]+/g) || [];
  deepEq(engineNet, [], "引擎里不许有网络地址");
});

section("11. 上报契约（DshOverlayHost.post 的 type 集合）");

test("球页能报出 ready/size/dragStart/drag/dragEnd/tap/longPress/taunt/wantSay/closed", () => {
  const posted = [];
  const clock = virtualClock();
  const managers = BallPage.createManager({
    win: { DshOverlayHost: { post: (json) => posted.push(JSON.parse(json)) } },
    doc: null, mount: null,
    now: clock.now,
    requestFrame: () => 1, cancelFrame: () => {},
    setInterval: () => 1, clearInterval: () => {},
    callbacks: { schedule: clock.after, cancel: clock.clear },
    renderer: () => {}
  });
  const api = managers.api;
  managers.start();
  api.state('{"emotion":"10","bubble":{"text":"被夸了","seq":1}}');

  // 走一遍手势：tap / 长按 / 拖动
  managers.gestures.down({ pointerId: 1, clientX: 10, clientY: 10, button: 0 });
  managers.gestures.up({ pointerId: 1, clientX: 10, clientY: 10 });
  managers.gestures.down({ pointerId: 2, clientX: 10, clientY: 10, button: 0 });
  clock.advance(500);
  managers.gestures.up({ pointerId: 2, clientX: 10, clientY: 10 });
  managers.gestures.down({ pointerId: 3, clientX: 10, clientY: 10, button: 0 });
  managers.gestures.move({ pointerId: 3, clientX: 30, clientY: 10 });
  managers.gestures.flushDrag(false);
  managers.gestures.up({ pointerId: 3, clientX: 30, clientY: 10 });

  api.cmd('{"name":"taunt"}');
  api.cmd('{"name":"bye"}');

  const types = posted.map((p) => p.type);
  for (const t of ["ready", "size", "dragStart", "drag", "dragEnd", "tap", "longPress", "taunt", "wantSay", "closed"]) {
    ok(types.includes(t), `缺上报类型：${t}`);
  }
  const size = posted.find((p) => p.type === "size");
  ok(size.w > 0 && size.h > 0, "size 必须带正数 w/h");
  const ready = posted.find((p) => p.type === "ready");
  ok(ready.w > 0 && ready.h > 0, "ready 必须带正数 w/h");
  const drag = posted.find((p) => p.type === "drag");
  ok(typeof drag.dx === "number" && typeof drag.dy === "number", "drag 带 dx/dy");
  const say = posted.find((p) => p.type === "wantSay");
  ok(typeof say.text === "string" && say.text.length > 0, "wantSay 带非空 text");
  console.log(`      实际上报序列：${types.join(" → ")}`);
});

test("wantSay 只在新气泡出现时报一次（同一句话不刷屏）", () => {
  const posted = [];
  const managers = BallPage.createManager({
    win: { DshOverlayHost: { post: (json) => posted.push(JSON.parse(json)) } },
    doc: null, mount: null, requestFrame: () => 1, cancelFrame: () => {},
    setInterval: () => 1, clearInterval: () => {}, renderer: () => {}
  });
  managers.start();
  managers.api.state('{"bubble":{"text":"同一句","seq":1}}');
  managers.api.state('{"bubble":{"text":"同一句","seq":1}}');
  managers.api.state('{"bubble":{"text":"新一句","seq":2}}');
  eq(posted.filter((p) => p.type === "wantSay").length, 2, "两句话 = 两条 wantSay");
});

test("cmd 的 resync / taunt / bye 语义正确，未知命令不炸", () => {
  const posted = [];
  const managers = BallPage.createManager({
    win: { DshOverlayHost: { post: (json) => posted.push(JSON.parse(json)) } },
    doc: null, mount: null, requestFrame: () => 1, cancelFrame: () => {},
    setInterval: () => 1, clearInterval: () => {}, renderer: () => {}
  });
  managers.start();
  managers.api.cmd('{"name":"resync"}');
  ok(posted.some((p) => p.type === "size"), "resync 会补报一次 size");
  managers.api.cmd('{"name":"taunt","args":{"text":"逗我"}}');
  eq(posted.find((p) => p.type === "taunt").text, "逗我");
  managers.api.cmd('{"name":"是什么"}');
  managers.api.cmd("junk");
  managers.api.cmd('{"name":"bye"}');
  ok(posted.some((p) => p.type === "closed"));
});

test("settings 入口：尺寸夹取、主题切换、非法值不覆盖", () => {
  const managers = BallPage.createManager({
    win: {}, doc: null, mount: null, requestFrame: () => 1, cancelFrame: () => {},
    setInterval: () => 1, clearInterval: () => {}, renderer: () => {}
  });
  const api = managers.api;
  api.settings('{"size":96}');
  eq(managers.getSettings().size, 96);
  eq(managers.measure().w, 96);
  api.settings('{"size":4}');
  eq(managers.getSettings().size, 32, "下限夹取");
  api.settings('{"size":9999}');
  eq(managers.getSettings().size, 320, "上限夹取");
  api.settings('{"theme":"cream"}');
  eq(managers.getSettings().theme, "cream");
  ok(managers.getSettings().bubble === true, "缺字段保持原值");
  api.settings('{"theme":null,"gaze":"yes"}');
  eq(managers.getSettings().theme, "cream", "非法主题不覆盖");
  eq(managers.getSettings().gaze, false, "非 true 一律视为关");
});

/* ============================================================================
 * 12~15. jsdom 端到端（可选）
 * ========================================================================== */

section(`12~15. jsdom 端到端（真引擎 + 真 DOM + 真事件）`);

async function loadJsdom() {
  const candidates = [process.env.DSH_JSDOM_ROOT, "/tmp/dsh-ball-test", ROOT].filter(Boolean);
  for (const root of candidates) {
    try {
      const req = createRequire(path.join(root, "index.js"));
      const resolved = req.resolve("jsdom");
      const mod = await import(`file://${resolved}`);
      if (mod && mod.JSDOM) return mod.JSDOM;
    } catch (err) { /* 换下一个候选 */ }
  }
  try {
    const mod = await import("jsdom");
    if (mod && mod.JSDOM) return mod.JSDOM;
  } catch (err) { /* 没装 */ }
  return null;
}

const JSDOM = await loadJsdom();

if (!JSDOM) {
  skip("jsdom 端到端用例", "没装 jsdom（npm i jsdom，或设置 DSH_JSDOM_ROOT）");
} else {
  console.log(`  （jsdom 已就绪）`);

  async function openPage({ html, url, codes, host = true }) {
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url });
    const w = dom.window;
    const posts = [];
    const pageErrors = [];
    w.addEventListener("error", (e) => pageErrors.push(String((e && e.message) || e)));
    if (host) w.DshOverlayHost = { post: (json) => posts.push(JSON.parse(json)) };
    w.__DSH_NO_AUTOSTART = true;
    for (const code of codes) w.eval(code);
    return { dom, w, posts, pageErrors, types: () => posts.map((p) => p.type) };
  }

  const BALL_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="dsh-stage"><div id="dsh-ball"></div></div></body></html>`;
  const BUBBLE_HTML = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="dsh-bubble-root"><div id="dsh-bubble"></div></div></body></html>`;

  await testAsync("球页脚本在真 DOM 里能挂载引擎并画出 svg", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const managers = page.w.__dshBallPage.install({ win: page.w, doc: page.w.document, autostart: true });
    const svg = page.w.document.querySelector("#dsh-ball svg");
    ok(svg, "引擎应该往容器里塞 svg");
    ok(managers.getEngine(), "引擎实例存在");
    eq(managers.getEngine().emotionId, "02", "默认待机");
    deepEq(page.pageErrors, [], "页面不该有未捕获错误");
    managers.destroy();
  });

  await testAsync("32 个表情全被引擎接受，且始终是同一个实例（不重建）", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const managers = page.w.__dshBallPage.install({ win: page.w, doc: page.w.document, autostart: true });
    const first = managers.getEngine();
    ok(first, "引擎实例存在");
    const seen = [];
    for (const emotion of BallPage.EMOTIONS) {
      page.w.__dshOverlay.state(JSON.stringify({ v: 1, emotion: emotion.id, running: true }));
      eq(managers.getEngine(), first, `${emotion.id} 切换后引擎被重建了`);
      eq(first.emotionId, emotion.id, `${emotion.id} ${emotion.name} 引擎没认`);
      seen.push(first.emotionId);
    }
    eq(new Set(seen).size, 32, "32 个表情逐一被接受且互不相同");
    // 未知 ID 回退待机而不是崩
    page.w.__dshOverlay.state('{"emotion":"99"}');
    eq(first.emotionId, "02", "未知表情回退待机");
    page.w.__dshOverlay.state('{"emotion":"ZZ","ts":"x"}');
    eq(first.emotionId, "02", "坏字段不炸");
    deepEq(page.pageErrors, [], "页面不该有未捕获错误");
    managers.destroy();
  });

  await testAsync("全页只有一个 rAF；空闲到点就停，不空转重绘", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const clock = virtualClock();
    let rafCount = 0;
    let pending = null;
    const managers = page.w.__dshBallPage.install({
      win: page.w, doc: page.w.document,
      now: clock.now,
      requestFrame: (fn) => { rafCount++; pending = fn; return rafCount; },
      cancelFrame: () => { pending = null; },
      autostart: true
    });
    eq(rafCount, 1, "启动时只挂一个 rAF");
    eq(managers.loop.isRunning(), true, "循环在跑");
    const pump = () => { const fn = pending; pending = null; if (fn) fn(clock.now()); };
    pump();
    eq(rafCount, 2, "同一个循环自己续帧，没有第二个循环");
    clock.advance(3000);
    managers.tickGuard();
    eq(managers.loop.isRunning(), false, "没有变化就该停下来（不空转）");
    const frozen = rafCount;
    for (let i = 0; i < 30; i++) managers.tickGuard();
    eq(rafCount, frozen, "停下之后不许再排帧");
    // 有交互再醒过来
    page.w.__dshOverlay.state('{"emotion":"30"}');
    eq(managers.loop.isRunning(), true, "状态变化唤醒");
    managers.destroy();
  });

  await testAsync("真实 DOM 指针事件：单击 / 长按 / 拖动三条路都通", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const clock = virtualClock();
    const managers = page.w.__dshBallPage.install({
      win: page.w, doc: page.w.document, now: clock.now,
      requestFrame: () => 1, cancelFrame: () => {},
      setInterval: () => 1, clearInterval: () => {},
      callbacks: { schedule: clock.after, cancel: clock.clear },
      autostart: true
    });
    const stage = page.w.document.getElementById("dsh-stage");
    const fire = (type, x, y) => {
      const ev = new page.w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
      stage.dispatchEvent(ev);
      return ev;
    };

    // 单击
    fire("pointerdown", 40, 40);
    fire("pointerup", 40, 40);
    // 拖动：>8px
    fire("pointerdown", 40, 40);
    fire("pointermove", 60, 40);
    fire("pointermove", 80, 40);
    fire("pointerup", 80, 40);
    // 长按：按住不动 0.5s
    fire("pointerdown", 40, 40);
    clock.advance(500);
    fire("pointerup", 40, 40);

    const types = page.types();
    ok(types.includes("tap"), "单击上报 tap");
    ok(types.includes("dragStart") && types.includes("dragEnd"), "拖动上报 dragStart/dragEnd");
    ok(types.includes("drag"), "拖动上报 drag");
    ok(types.includes("longPress"), "长按上报 longPress");
    eq(types.filter((t) => t === "tap").length, 1, "拖动和长按都不该额外产生 tap");
    eq(page.w.document.getElementById("dsh-stage").getAttribute("data-dragging"), "0", "拖动结束后归位");
    deepEq(page.pageErrors, [], "页面不该有未捕获错误");
    managers.destroy();
  });

  await testAsync("拖动能拖动整窗：drag 的 dx/dy 是逻辑 px 位移", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const clock = virtualClock();
    const managers = page.w.__dshBallPage.install({
      win: page.w, doc: page.w.document, now: clock.now,
      requestFrame: () => 1, cancelFrame: () => {},
      setInterval: () => 1, clearInterval: () => {},
      callbacks: { schedule: clock.after, cancel: clock.clear },
      autostart: true
    });
    const stage = page.w.document.getElementById("dsh-stage");
    const fire = (type, x, y) => stage.dispatchEvent(new page.w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    page.posts.length = 0;
    fire("pointerdown", 100, 100);
    fire("pointermove", 130, 140);
    fire("pointerup", 130, 140);
    const drags = page.posts.filter((p) => p.type === "drag");
    ok(drags.length >= 1, "应该至少报一条 drag");
    const sumX = drags.reduce((a, p) => a + p.dx, 0);
    const sumY = drags.reduce((a, p) => a + p.dy, 0);
    eq(sumX, 30, "dx 总和 = 位移");
    eq(sumY, 40, "dy 总和 = 位移");
    managers.destroy();
  });

  await testAsync("console 之外不发任何网络请求", async () => {
    const page = await openPage({ html: BALL_HTML, url: "file:///android_asset/ball/index.html", codes: [SRC.engine, SRC.ball] });
    const net = { fetch: 0, xhr: 0, beacon: 0, ws: 0, img: 0 };
    page.w.fetch = () => { net.fetch++; return Promise.resolve({}); };
    page.w.XMLHttpRequest = function () { net.xhr++; this.open = () => {}; this.send = () => {}; };
    page.w.navigator.sendBeacon = () => { net.beacon++; return true; };
    page.w.WebSocket = function () { net.ws++; };
    const managers = page.w.__dshBallPage.install({ win: page.w, doc: page.w.document, autostart: true });
    for (const e of BallPage.EMOTIONS) page.w.__dshOverlay.state(JSON.stringify({ emotion: e.id }));
    page.w.__dshOverlay.settings('{"theme":"cream"}');
    page.w.__dshOverlay.cmd('{"name":"resync"}');
    // 气泡页也来一遍
    const bpage = await openPage({ html: BUBBLE_HTML, url: "file:///android_asset/ball/bubble.html", codes: [SRC.bubble] });
    bpage.w.fetch = page.w.fetch;
    bpage.w.XMLHttpRequest = page.w.XMLHttpRequest;
    bpage.w.__dshBubblePage.install({ win: bpage.w, doc: bpage.w.document });
    bpage.w.__dshOverlay.setup('{"side":"bottom","tipX":30}');
    bpage.w.__dshOverlay.bubble('{"text":"离线也能说话","seq":1}');
    bpage.w.__dshOverlay.done();
    deepEq(net, { fetch: 0, xhr: 0, beacon: 0, ws: 0, img: 0 }, "不该有任何网络调用");
    managers.destroy();
  });

  await testAsync("气泡页真 DOM：先报 bubbleSize 再显示，data-side/tipX 落到位", async () => {
    const page = await openPage({ html: BUBBLE_HTML, url: "file:///android_asset/ball/bubble.html", codes: [SRC.bubble] });
    const core = page.w.__dshBubblePage.install({ win: page.w, doc: page.w.document });
    const el = page.w.document.getElementById("dsh-bubble");

    page.w.__dshOverlay.setup('{"side":"bottom","tipX":36,"maxW":210,"theme":"cream"}');
    page.w.__dshOverlay.bubble('{"text":"先报尺寸再显示","source":"ai","mood":"10","seq":1}');

    const size = page.posts.find((p) => p.type === "bubbleSize");
    ok(size && size.w > 0 && size.h > 0, "必须上报有效 bubbleSize");
    eq(page.types()[0], "bubbleSize", "尺寸是第一条上报");
    eq(el.getAttribute("data-shown"), "0", "报尺寸这一刻不能显示（防闪）");
    eq(el.getAttribute("data-side"), "bottom", "尖尖朝向按 setup");
    eq(el.style.getPropertyValue("--dsh-tip-x"), "36px", "尖尖位置按 setup");
    eq(page.w.document.documentElement.getAttribute("data-theme"), "cream");
    eq(el.getAttribute("data-tone"), "warm", "mood=10 暖色");
    core.api.done();
    ok(page.types().includes("bubbleDone"), "done 回执");
    deepEq(page.pageErrors, [], "页面不该有未捕获错误");
  });

  await testAsync("宿主不存在（浏览器里调试）时全部静默", async () => {
    const page = await openPage({
      html: BALL_HTML, url: "file:///android_asset/ball/index.html",
      codes: [SRC.engine, SRC.ball], host: false
    });
    const managers = page.w.__dshBallPage.install({ win: page.w, doc: page.w.document, autostart: true });
    page.w.__dshOverlay.state('{"emotion":"33"}');
    page.w.__dshOverlay.host("junk");
    page.w.__dshOverlay.settings(null);
    page.w.__dshOverlay.cmd("{");
    managers.gestures.down({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
    managers.gestures.up({ pointerId: 1, clientX: 0, clientY: 0 });
    deepEq(page.pageErrors, [], "DshOverlayHost 不存在也不能抛");
    managers.destroy();
  });
}

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n${"─".repeat(64)}`);
if (failed === 0) {
  console.log(`全部通过：${passed} 项通过，${skipped} 项跳过，0 项失败`);
} else {
  console.log(`失败：${failed} 项，通过 ${passed} 项，跳过 ${skipped} 项`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err && f.err.message}`);
}
process.exit(failed === 0 ? 0 : 1);
