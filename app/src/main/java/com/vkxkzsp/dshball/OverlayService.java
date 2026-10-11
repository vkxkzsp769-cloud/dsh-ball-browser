package com.vkxkzsp.dshball;

import android.annotation.SuppressLint;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * OverlayService —— 系统悬浮窗里的表情球（契约第 4 节 + 修订 A）。
 *
 * 两个窗口：
 *   球窗   —— 可触摸（拖动 / 单击 / 长按），加载 assets/ball/index.html
 *   气泡窗 —— 不可触摸（FLAG_NOT_TOUCHABLE），加载 assets/ball/bubble.html
 * 拆成两个窗口的原因：透明悬浮窗会吃掉窗口范围内的所有触摸，气泡和球同窗会挡住下面的 App。
 *
 * 本服务不做前台通知：进程由 KeepAliveService（前台服务）保着，这里只负责画球。
 */
public class OverlayService extends Service implements Bridge.Listener {

    private static final String TAG = "DshBallOverlay";

    public static final String ACTION_SHOW = "com.vkxkzsp.dshball.OVERLAY_SHOW";
    public static final String ACTION_HIDE = "com.vkxkzsp.dshball.OVERLAY_HIDE";
    public static final String ACTION_REFRESH = "com.vkxkzsp.dshball.OVERLAY_REFRESH";

    private static volatile boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    private WindowManager wm;
    private final Handler main = new Handler(Looper.getMainLooper());

    private WebView ballWeb;
    private WindowManager.LayoutParams ballLp;
    private boolean ballAdded = false;

    private WebView bubbleWeb;
    private WindowManager.LayoutParams bubbleLp;
    private boolean bubbleAdded = false;
    private int bubbleW = 1, bubbleH = 1;

    private int ballSizePx;
    private int lastBubbleSeq = Integer.MIN_VALUE;
    private String lastBubbleText = "";
    private boolean ballReady = false;
    private boolean bubbleReady = false;

    private long lastResyncAt = 0L;

    /* ============================ 生命周期 ============================ */

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        Bridge.get().addListener(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_SHOW : intent.getAction();
        if (ACTION_HIDE.equals(action)) {
            removeWindows();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_REFRESH.equals(action)) {
            removeWindows();
        }
        if (canDraw(this)) {
            showWindows();
        } else {
            Log.w(TAG, "没有悬浮窗权限，跳过");
            stopSelf();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Bridge.get().removeListener(this);
        removeWindows();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ============================ 权限 ============================ */

    public static boolean canDraw(Context c) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return Settings.canDrawOverlays(c);
        }
        return true;
    }

    public static void requestPermission(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "requestPermission failed", t);
        }
    }

    /** 设置改了（大小/主题/开关）后重建窗口。 */
    public static void refresh(Context c) {
        try {
            if (!Prefs.overlayOn(c)) {
                c.startService(new Intent(c, OverlayService.class).setAction(ACTION_HIDE));
                return;
            }
            if (!canDraw(c)) return;
            c.startService(new Intent(c, OverlayService.class).setAction(ACTION_REFRESH));
        } catch (Throwable t) {
            Log.w(TAG, "refresh failed", t);
        }
    }

    /* ============================ 窗口 ============================ */

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void showWindows() {
        main.post(() -> {
            try {
                if (!ballAdded) addBallWindow();
                pushSettings();
                BallState s = Bridge.get().state();
                if (s != null) onState(s);
                running = true;
            } catch (Throwable t) {
                Log.w(TAG, "showWindows failed", t);
                BallApp.writeCrash(t);
            }
        });
    }

    private void removeWindows() {
        running = false;
        main.post(() -> {
            try {
                if (bubbleAdded && bubbleWeb != null) wm.removeView(bubbleWeb);
            } catch (Throwable ignored) {
            }
            bubbleAdded = false;
            try {
                if (ballAdded && ballWeb != null) wm.removeView(ballWeb);
            } catch (Throwable ignored) {
            }
            ballAdded = false;
            try {
                if (ballWeb != null) {
                    ballWeb.destroy();
                    ballWeb = null;
                }
                if (bubbleWeb != null) {
                    bubbleWeb.destroy();
                    bubbleWeb = null;
                }
            } catch (Throwable ignored) {
            }
            ballReady = false;
            bubbleReady = false;
        });
    }

    private int overlaySizeDp() {
        int size = Prefs.overlaySize(this);
        if (Prefs.useWebConfig(this)) {
            BallState s = Bridge.get().state();
            if (s != null) {
                int fromWeb = s.cfg().optInt("size", 0);
                if (fromWeb >= 48 && fromWeb <= 160) size = fromWeb;
            }
        }
        return Prefs.clamp(size, 48, 160);
    }

    private String overlayTheme() {
        if (Prefs.useWebConfig(this)) {
            BallState s = Bridge.get().state();
            if (s != null) {
                String t = s.cfg().optString("theme", "");
                if ("cream".equals(t) || "dark".equals(t)) return t;
            }
        }
        return Prefs.overlayTheme(this);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView newOverlayWeb() {
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        /* 只加载本地 asset，页面自己不发任何网络请求 */
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setBlockNetworkLoads(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        v.setBackgroundColor(0x00000000);
        v.setVerticalScrollBarEnabled(false);
        v.setHorizontalScrollBarEnabled(false);
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        return v;
    }

    private void addBallWindow() {
        ballSizePx = dp(overlaySizeDp());
        ballWeb = newOverlayWeb();
        ballWeb.addJavascriptInterface(new OverlayJs(), "DshOverlayHost");
        ballLp = new WindowManager.LayoutParams(
                ballSizePx, ballSizePx,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        ballLp.gravity = Gravity.TOP | Gravity.START;
        int[] xy = initialPosition(ballSizePx);
        ballLp.x = xy[0];
        ballLp.y = xy[1];
        wm.addView(ballWeb, ballLp);
        ballAdded = true;
        ballWeb.loadUrl("file:///android_asset/ball/index.html");
    }

    private int[] initialPosition(int size) {
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        float rx = Prefs.sp(this).getFloat(Prefs.OVERLAY_X, -1f);
        float ry = Prefs.sp(this).getFloat(Prefs.OVERLAY_Y, -1f);
        int x, y;
        if (rx < 0 || ry < 0) {
            x = sw - size - dp(12);
            y = sh - size - dp(64);
        } else {
            x = Math.round(rx * sw);
            y = Math.round(ry * sh);
        }
        return new int[]{ clamp(x, 0, Math.max(0, sw - size)), clamp(y, 0, Math.max(0, sh - size)) };
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private void persistPosition() {
        if (ballLp == null) return;
        int sw = Math.max(1, getResources().getDisplayMetrics().widthPixels);
        int sh = Math.max(1, getResources().getDisplayMetrics().heightPixels);
        Prefs.sp(this).edit()
                .putFloat(Prefs.OVERLAY_X, ballLp.x / (float) sw)
                .putFloat(Prefs.OVERLAY_Y, ballLp.y / (float) sh)
                .apply();
    }

    private void moveBall(int dx, int dy) {
        if (!ballAdded || ballLp == null) return;
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        ballLp.x = clamp(ballLp.x + dx, 0, Math.max(0, sw - ballSizePx));
        ballLp.y = clamp(ballLp.y + dy, 0, Math.max(0, sh - ballSizePx));
        try {
            wm.updateViewLayout(ballWeb, ballLp);
        } catch (Throwable t) {
            Log.w(TAG, "moveBall failed", t);
        }
        placeBubble();
    }

    /* ============================ 气泡窗 ============================ */

    private void ensureBubbleWindow() {
        if (bubbleAdded) return;
        bubbleWeb = newOverlayWeb();
        bubbleWeb.addJavascriptInterface(new OverlayJs(), "DshOverlayHost");
        bubbleLp = new WindowManager.LayoutParams(
                Math.max(1, bubbleW), Math.max(1, bubbleH),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        bubbleLp.gravity = Gravity.TOP | Gravity.START;
        bubbleLp.x = ballLp == null ? 0 : ballLp.x;
        bubbleLp.y = ballLp == null ? 0 : Math.max(0, ballLp.y - bubbleH - dp(10));
        try {
            wm.addView(bubbleWeb, bubbleLp);
            bubbleAdded = true;
            bubbleWeb.loadUrl("file:///android_asset/ball/bubble.html");
        } catch (Throwable t) {
            Log.w(TAG, "add bubble failed", t);
            bubbleAdded = false;
        }
    }

    /** 把气泡窗摆到球的上方（放不下就下方），横向贴边夹取。 */
    private void placeBubble() {
        if (!bubbleAdded || bubbleLp == null || ballLp == null) return;
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        int ballCx = ballLp.x + ballSizePx / 2;
        int x = clamp(ballCx - bubbleW / 2, dp(6), Math.max(dp(6), sw - bubbleW - dp(6)));
        boolean above = ballLp.y - bubbleH - dp(10) >= dp(6);
        int y = above ? ballLp.y - bubbleH - dp(10)
                : clamp(ballLp.y + ballSizePx + dp(10), dp(6), Math.max(dp(6), sh - bubbleH - dp(6)));
        int tipX = clamp(ballCx - x, 14, Math.max(14, bubbleW - 14));
        bubbleLp.x = x;
        bubbleLp.y = y;
        try {
            wm.updateViewLayout(bubbleWeb, bubbleLp);
        } catch (Throwable t) {
            Log.w(TAG, "placeBubble failed", t);
        }
        evalBubble("window.__dshOverlay && window.__dshOverlay.setup && window.__dshOverlay.setup("
                + JSONObject.quote(bubbleSetupJson(above ? "top" : "bottom", tipX)) + ")");
    }

    private String bubbleSetupJson(String side, int tipX) {
        try {
            JSONObject o = new JSONObject();
            o.put("side", side);
            o.put("tipX", tipX);
            o.put("maxW", 230);
            o.put("theme", overlayTheme());
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    private void showBubble(String text, int seq, String source, String mood) {
        if (!Prefs.bubbleOn(this)) return;
        if (text == null || text.isEmpty()) return;
        ensureBubbleWindow();
        if (!bubbleAdded) return;
        try {
            JSONObject o = new JSONObject();
            o.put("text", text);
            o.put("seq", seq);
            o.put("source", source == null ? "" : source);
            o.put("mood", mood == null ? "" : mood);
            evalBubble("window.__dshOverlay && window.__dshOverlay.bubble && window.__dshOverlay.bubble("
                    + JSONObject.quote(o.toString()) + ")");
        } catch (Throwable t) {
            Log.w(TAG, "showBubble failed", t);
        }
    }

    private void hideBubble() {
        if (!bubbleAdded) return;
        main.post(() -> {
            try {
                if (bubbleAdded && bubbleWeb != null) wm.removeView(bubbleWeb);
            } catch (Throwable ignored) {
            }
            bubbleAdded = false;
            try {
                if (bubbleWeb != null) {
                    bubbleWeb.destroy();
                    bubbleWeb = null;
                }
            } catch (Throwable ignored) {
            }
            bubbleReady = false;
        });
    }

    /* ============================ 状态分发 ============================ */

    @Override
    public void onState(final BallState s) {
        if (s == null) return;
        main.post(() -> {
            try {
                /* 网页失联时，让页面替我们去宿主端点要一次状态（同源、带 cookie，不用另做鉴权） */
                maybeResync(s);

                if (Prefs.useWebConfig(this)) {
                    int want = dp(overlaySizeDp());
                    if (want != ballSizePx) {
                        ballSizePx = want;
                        if (ballLp != null) {
                            ballLp.width = want;
                            ballLp.height = want;
                            try {
                                wm.updateViewLayout(ballWeb, ballLp);
                            } catch (Throwable ignored) {
                            }
                        }
                    }
                }

                evalBall("window.__dshOverlay && window.__dshOverlay.state && window.__dshOverlay.state("
                        + JSONObject.quote(s.toJson()) + ")");

                JSONObject host = new JSONObject();
                host.put("type", "host");
                host.put("dsh", s.src().equals(BallState.SRC_WEB) ? "up" : "degraded");
                host.put("lastPushAgo", Bridge.get().lastPushAgo());
                host.put("keepAlive", KeepAliveService.isRunning());
                host.put("overlay", true);
                String hostJson = JSONObject.quote(host.toString());
                evalBall("window.__dshOverlay && window.__dshOverlay.host && window.__dshOverlay.host(" + hostJson + ")");
                evalBubble("window.__dshOverlay && window.__dshOverlay.host && window.__dshOverlay.host(" + hostJson + ")");

                JSONObject b = s.json().optJSONObject("bubble");
                if (b != null) {
                    String text = b.optString("text", "");
                    int seq = b.optInt("seq", -1);
                    boolean isNew = !text.isEmpty()
                            && (seq >= 0 ? seq != lastBubbleSeq : !text.equals(lastBubbleText));
                    if (isNew) {
                        lastBubbleSeq = seq;
                        lastBubbleText = text;
                        showBubble(text, seq, b.optString("source", ""), b.optString("mood", ""));
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "onState failed", t);
            }
        });
    }

    @Override
    public void onPluginSeen(boolean seen) {
        pushSettings();
    }

    private void maybeResync(BallState s) {
        if (!Prefs.pollHost(this)) return;
        if (Bridge.get().fresh()) return;
        long now = System.currentTimeMillis();
        if (now - lastResyncAt < 10_000L) return;
        lastResyncAt = now;
        MainActivity a = Bridge.get().activity();
        if (a == null) return;
        /* 走页面上下文请求，避免自己造一套鉴权 */
        a.evalJs("(function(){try{"
                + "var rid='rs-'+Date.now().toString(36);"
                + "fetch('/dsh-ball-bridge/status',{method:'POST',headers:{'content-type':'application/json'},"
                + "body:JSON.stringify({rpcId:rid,type:'client-request',method:'dsh-ball-bridge/status',payload:{}}),"
                + "credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){"
                + "var st=j&&(j.value&&j.value.state||j.state);"
                + "if(st&&window." + WebBridge.NAME + "){window." + WebBridge.NAME + ".post(JSON.stringify({type:'state',state:st}))}"
                + "}).catch(function(){})}catch(e){}})();");
    }

    private void pushSettings() {
        try {
            JSONObject o = new JSONObject();
            o.put("size", overlaySizeDp());
            o.put("theme", overlayTheme());
            o.put("gaze", true);
            o.put("bubble", Prefs.bubbleOn(this));
            o.put("opacity", 1.0);
            o.put("locked", false);
            String q = JSONObject.quote(o.toString());
            evalBall("window.__dshOverlay && window.__dshOverlay.settings && window.__dshOverlay.settings(" + q + ")");
            evalBubble("window.__dshOverlay && window.__dshOverlay.settings && window.__dshOverlay.settings(" + q + ")");
        } catch (Throwable t) {
            Log.w(TAG, "pushSettings failed", t);
        }
    }

    private void evalBall(String js) {
        if (ballWeb == null || !ballReady) return;
        try {
            ballWeb.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "evalBall failed", t);
        }
    }

    private void evalBubble(String js) {
        if (bubbleWeb == null || !bubbleReady) return;
        try {
            bubbleWeb.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "evalBubble failed", t);
        }
    }

    /* ============================ 页面 -> App ============================ */

    private class OverlayJs {

        @JavascriptInterface
        public void post(String json) {
            try {
                if (json == null || json.isEmpty()) return;
                JSONObject o = new JSONObject(json);
                String type = o.optString("type", "");
                switch (type) {
                    case "ready":
                        if (o.optBoolean("bubble", false)) bubbleReady = true;
                        else ballReady = true;
                        main.post(() -> {
                            pushSettings();
                            BallState s = Bridge.get().state();
                            if (s != null) onState(s);
                        });
                        break;
                    case "size":
                        ballSizePx = dp((float) o.optDouble("w", overlaySizeDp()));
                        if (ballLp != null) {
                            ballLp.width = ballSizePx;
                            ballLp.height = ballSizePx;
                            main.post(() -> {
                                try {
                                    wm.updateViewLayout(ballWeb, ballLp);
                                } catch (Throwable ignored) {
                                }
                            });
                        }
                        break;
                    case "bubbleSize": {
                        bubbleW = Math.max(1, dp((float) o.optDouble("w", 200)));
                        bubbleH = Math.max(1, dp((float) o.optDouble("h", 44)));
                        main.post(() -> {
                            if (bubbleLp != null) {
                                bubbleLp.width = bubbleW;
                                bubbleLp.height = bubbleH;
                            }
                            placeBubble();
                        });
                        break;
                    }
                    case "bubbleDone":
                        hideBubble();
                        break;
                    case "bubbleTap":
                        break;
                    case "drag": {
                        int dx = dp((float) o.optDouble("dx", 0));
                        int dy = dp((float) o.optDouble("dy", 0));
                        main.post(() -> moveBall(dx, dy));
                        break;
                    }
                    case "dragEnd":
                        main.post(OverlayService.this::persistPosition);
                        break;
                    case "dragStart":
                        break;
                    case "tap":
                        main.post(() -> {
                            MainActivity a = Bridge.get().activity();
                            if (a != null) a.onOverlayTap();
                            else Bridge.get().requestTaunt(null);
                        });
                        break;
                    case "longPress":
                        main.post(() -> {
                            MainActivity a = Bridge.get().activity();
                            if (a != null) a.openSettings();
                            else openAppSettings();
                        });
                        break;
                    case "taunt": {
                        String text = o.optString("text", "");
                        main.post(() -> Bridge.get().requestTaunt(text));
                        break;
                    }
                    case "wantSay": {
                        String text = o.optString("text", "");
                        if (!text.isEmpty()) {
                            showBubble(text, (int) (System.currentTimeMillis() / 1000), "local", "");
                        }
                        break;
                    }
                    case "openApp":
                        main.post(() -> Bridge.get().openApp(OverlayService.this));
                        break;
                    case "closed":
                        main.post(() -> {
                            Prefs.put(OverlayService.this, Prefs.OVERLAY_ON, false);
                            removeWindows();
                        });
                        break;
                    default:
                        break;
                }
            } catch (Throwable t) {
                Log.w(TAG, "OverlayJs.post failed", t);
            }
        }
    }

    private void openAppSettings() {
        try {
            Intent i = new Intent(this, SettingsActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "openAppSettings failed", t);
        }
    }
}
