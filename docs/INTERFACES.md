# 冻结接口契约 v1（改这里之前先在团队里说一声）

本文件是所有并行开发的**唯一真相**。App 侧（Java）、悬浮窗页（assets/ball）、
dsh 插件（plugin/）三部分只允许按这里的名字、字段、格式互相调用。

## 0. 名词

| 名字 | 说明 |
| --- | --- |
| 主 WebView | App 里加载 `http://127.0.0.1:3080` 的 WebView（浏览器本体） |
| 悬浮窗 WebView | `TYPE_APPLICATION_OVERLAY` 窗口里的 WebView，加载 `file:///android_asset/ball/index.html` |
| dsh 插件 | `plugin/`（包名 `@dsh-local/dsh-ball-bridge`），装进 dsh web 花名册，把表情球状态推给 App |
| Java 包名 | `com.vkxkzsp.dshball` |

## 1. BallState（状态信封，JSON，v1）

App 内部、插件 → App、App → 悬浮窗页，**三方共用同一个信封**。
未知字段必须忽略，缺失字段必须按默认值兜底（任何一侧都不许因为缺字段崩）。

```jsonc
{
  "v": 1,                       // 协议版本，固定 1
  "ts": 1730000000000,          // 产生时刻（毫秒时间戳）
  "src": "web",                 // "web"=页面推的（权威） | "host"=宿主端点轮询 | "native"=App 自己推断
  "emotion": "32",              // 两位表情 ID（"00"~"41"），空串 = 未知
  "emotionName": "处理中忙碌",   // 表情名，可空
  "running": true,              // 是否有一轮对话在跑
  "mood": "10",                 // AI 心情表情 ID，可空
  "taskMood": "30",             // 生命循环工作表情 ID，可空
  "reason": "被夸了",            // 心情理由，<=60 字，可空
  "bubble": { "text": "...", "source": "ai", "mood": "16", "seq": 12 },
  "pricing": { "tier": "offpeak", "hhmm": "23:12", "label": "空闲" },
  "cfg": { "size": 96, "theme": "dark", "gaze": true, "bubble": true }
}
```

- 表情 ID 一律**字符串**两位数字，不要给数字类型。
- 时间统一毫秒；App 自己做超时判定（>15 秒没推 => 视为失联）。
- `bubble`、`pricing`、`cfg`、`mood`、`taskMood`、`reason` 允许为 `null`/缺失。

## 2. 表情 ID 全集（32 个，和 grok-ball 一致，不许自创）

```
生命周期 00睡眠 01唤醒 02待机放空 03好奇 04发呆 05加载苏醒 06休眠 07抖动唤醒
情绪反应 10开心 11疑惑 12失落 13惊讶 14害羞 15疲惫 16专注 17慌张 18无奈 19满意 20困惑 21生气
工作状态 30思考中 31接收任务 32处理中忙碌 33任务完成 34出错 35等待输入 36联网加载
        37复述回忆 38拒绝受限 39输出回复 40检索资料 41停止终止
```

`assets/ball/ball.js` 必须自建一份 32 项 `{id,name}` 表（悬浮窗页不能依赖 dsh 模块表）。

## 3. 主 WebView <-> Java

### 3.1 页面 -> Java（JS 接口，名字固定 `DshBallApp`）

网页调用 `window.DshBallApp.post(jsonString)`，解析后至少含 `type`：

| type | 字段 | 语义 |
| --- | --- | --- |
| `state` | BallState（`src` 由 App 覆写为 `web`） | 插件推的权威状态 |
| `hello` | `plugin`, `version` | 插件刚挂上，App 回一次 host 信息 |
| `open` | `url` | 用系统浏览器打开链接（可选） |
| `toast` | `text` | App 弹 toast |
| `log` | `text`, `level` | 转发到 App 日志（调试用） |

失败必须静默：页面侧任何异常都不许影响 dsh 本体。

### 3.2 Java -> 页面

Java 调 `webView.evaluateJavascript("window.__dshBallApp.host(" + json + ")", null)`。
`window.__dshBallApp` 由插件创建；页面没有它时 App 的调用**必须被忽略**（不报错）。

```jsonc
{ "type": "host", "keepAlive": true, "pluginSeen": true, "ts": 1730000000000 }
```

## 4. Java <-> 悬浮窗 WebView

### 4.1 Java -> 悬浮窗页

- `window.__dshOverlay.state(jsonString)` — BallState（App 只透传，不改字段）
- `window.__dshOverlay.host(jsonString)` — `{ "type":"host", "dsh":"up|down", "lastPushAgo":1234, "keepAlive":true, "overlay":true }`
- `window.__dshOverlay.settings(jsonString)` — `{ "size":96, "theme":"dark", "gaze":true, "bubble":true, "opacity":1.0, "locked":false }`
- `window.__dshOverlay.cmd(jsonString)` — `{ "name":"resync" | "taunt" | "bye", "args":{} }`

页面对不存在/非法字段必须容错。

### 4.2 悬浮窗页 -> Java（JS 接口，名字固定 `DshOverlayHost`）

`window.DshOverlayHost.post(jsonString)`：

| type | 字段 | 语义 |
| --- | --- | --- |
| `ready` | `w`,`h` | 页面就绪，报告内容尺寸（逻辑 px，App 乘 density） |
| `size` | `w`,`h` | 球尺寸/窗口尺寸变化 |
| `dragStart` / `dragEnd` | — | 开始/结束拖动悬浮窗 |
| `drag` | `dx`,`dy` | 相对位移（逻辑 px），App 更新窗口坐标并做边界夹取 |
| `tap` | — | 单击球（App 广播给网页做同一动作） |
| `longPress` | — | 长按 0.5 秒（App 打开设置页） |
| `taunt` | `text` | 要 App 找网页要一句新台词 |
| `wantSay` | `text` | 悬浮球自己拼好的一句（零 token 兜底） |
| `openApp` | — | 点小图标切回 App |
| `closed` | — | 请求关闭悬浮窗 |

### 4.3 手势规则（和网页版一致）

- 单击 = 自旋 + 撒花 + 说一句；长按 0.5 秒 = 打开设置；可拖动
- 位移 > 8 逻辑 px 就取消 tap
- 禁文本选中/系统长按菜单：`user-select:none; -webkit-touch-callout:none; touch-action:none`
- 不支持双击

## 5. 悬浮窗页技术约束

- 纯静态 `assets/ball/index.html` + `ball.js` + `style.css`，零外链、零 CDN（离线可用）
- 32 个表情必须都能画出来（不许只画 3 个占位）
- 统一一个 rAF；无状态变化不许空转重绘，空闲降到 1fps 心跳
- 只保留最后一份 BallState + 最后 2 条气泡排队
- 除 `console` 外不许发起任何网络请求

## 6. dsh 插件（plugin/）

- 包名 `@dsh-local/dsh-ball-bridge`；`exports["."] = lib/index.js`（宿主半，只用 node 内建）、
  `exports["./client"] = lib/client.js`（浏览器半）
- `dsh.client.platform = "web"`；`inject = ["sessions"]`
- 宿主半注册通道 **`/dsh-ball-bridge`**（照抄 dsh-float-pet 的可用写法）：
  - `POST /dsh-ball-bridge/status`：请求 `{}` -> `{ ok:true, value:{ state } }`；`state` 为最近一次
    客户端推上来的 BallState，没有则 `null`
  - 鉴权复用 `scoped.connection.admit(req)`；非 POST 回 405；未知 endpoint 回 404
- 客户端半默认开、poll-free：只有发现 `window.DshBallApp` 时才推，没有就完全静默
- **血泪坑**：cordis 4 下第三方插件直接 `ctx.connection.rpc.handle()` 必挂，必须
  `ctx.inject(['webServer'], scoped => scoped.effect(() => scoped.webServer.register({kind:'prefix', path:'/dsh-ball-bridge', handler})))`
  并走 Connection 信封（`{rpcId, type:'client-request', method, payload}` /
  `{rpcId, type:'server-response', ok, value|error}`）
- 推送节流：状态变化即时推；无变化最多 1 条/5 秒心跳；气泡文本变化立刻推

## 7. App 侧关键约定

- 设置项：`baseUrl`(默认 `http://127.0.0.1:3080`)、`overlayOn`、`overlaySize`、`overlayTheme`、
  `useWebConfig`、`pollHostStatus`、`bubbleOn`、`keepAliveNotif`、`userAgentDesktop`、`zoom`、
  `startOnBoot=false`（本次不做）、`pricingAnchor`（预留）
- 保活：前台服务 + 常驻通知 + 申请忽略电池优化 + WebView 不因后台销毁；
  **不做**开机自启、不做 Alarm 互拉
- 悬浮窗开关在 App 内和通知里都能一键切
- 悬浮球位置按屏幕比例持久化，重启回可视区域

## 8. 改接口的流程

1. 先改本文件（带 v2 说明）；2. 通知另外两方并确认；3. 任何一方不许偷偷加字段语义。

---

# 附：v1 修订 A（2026-10-11）—— 气泡独立成窗

**原因**：`TYPE_APPLICATION_OVERLAY` 的透明窗口会吃掉窗口范围内的所有触摸。
若球和气泡共用一个大窗口，气泡那块区域就会挡住下面的 App（点不动）。所以拆成两个窗口：

| 窗口 | 内容 | 触摸 | 尺寸 |
| --- | --- | --- | --- |
| 球窗 | `file:///android_asset/ball/index.html` | **可触摸**（拖动/单击/长按） | `overlaySize` × `overlaySize`（dp） |
| 气泡窗 | `file:///android_asset/ball/bubble.html` | **不可触摸**（`FLAG_NOT_TOUCHABLE`） | 内容尺寸，App 按页面上报值开窗 |

因此悬浮窗页要交两个 HTML：`index.html`（球）与 `bubble.html`（气泡），共用 `style.css` / 引擎。
`bubble.html` 只负责打字/排队/续时/尖尖朝向；位置与朝向由 App 算（它知道球窗坐标与屏幕边界）。

## 新增 JS 接口（覆盖前面第 4 节里跟气泡有关的部分）

App -> 球页（`index.html`）仍然只有 `state / host / settings / cmd`；球页**不再**自己画气泡，
收到带 `bubble` 的 state 后只上报，由 App 决定要不要开气泡窗。

App -> 气泡页（`bubble.html`）：

- `window.__dshOverlay.setup(json)` — `{ "side":"top"|"bottom", "tipX":40, "maxW":230, "theme":"dark" }`
- `window.__dshOverlay.bubble(json)` — 同 BallState.bubble：`{ "text","source","mood","seq" }`；
  新 `seq` 才打字，同 `seq` 忽略；正在播时进队列（上限 2，丢最旧）
- `window.__dshOverlay.done()` — App 说「这轮结束，可以收了」

气泡页 -> App（`DshOverlayHost.post`）：

| type | 字段 | 语义 |
| --- | --- | --- |
| `bubbleSize` | `w`,`h` | 内容尺寸（逻辑 px），App 乘 density 开窗 |
| `bubbleDone` | — | 这条读完且队列空了，App 关窗 |
| `bubbleTap` | — | 用户点了气泡（App 不用处理，仅记录） |

气泡页同样禁触摸选中、发 `bubbleSize` 前不许显示（避免闪一下）。

## 球页（index.html）的尺寸约定

- 球窗就是 `overlaySize` 见方，页面 `body` 铺满，球画满整窗（`width:100%;height:100%`）。
- 撒花/自旋等特效必须裁剪在球窗内（`overflow:hidden`），不许超出窗口。
