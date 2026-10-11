package com.vkxkzsp.dshball;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Bridge —— App 里唯一的状态中枢（对应 docs/INTERFACES.md 第 1、3、4 节）。
 *
 * 数据流：
 *   dsh 网页（插件） --post(state)--> Bridge --> 悬浮窗 Service --> 悬浮窗页
 *   dsh 宿主端点（轮询）  ------------------>/
 *
 * 任何一侧都不直接持有另一侧的引用，避免循环依赖与内存泄漏。
 */
public final class Bridge {

    public static final String TAG = "DshBallBridge";

    /** 页面推来的状态超过这个时间没更新，就认为「网页失联」。 */
    public static final long STALE_MS = 15_000L;

    public interface Listener {
        /** 状态更新（已在主线程）。 */
        void onState(BallState state);

        /** 页面里有没有装 dsh-ball-bridge 插件。 */
        void onPluginSeen(boolean seen);
    }

    private static final Bridge INSTANCE = new Bridge();

    public static Bridge get() {
        return INSTANCE;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Listener> listeners = new ArrayList<>();

    private volatile BallState state;
    private volatile String bubbleText = "";
    private volatile int bubbleSeq = -1;
    private volatile boolean pluginSeen = false;
    private volatile long lastPushAt = 0L;

    /** 主 WebView（页面 -> App 的接口落点），MainActivity 创建后挂上。 */
    private volatile MainActivity activity;

    private Bridge() {
    }

    /* ============================ 注册/广播 ============================ */

    public void addListener(Listener l) {
        synchronized (listeners) {
            if (!listeners.contains(l)) listeners.add(l);
        }
        BallState s = state;
        if (s != null) l.onState(s);
        l.onPluginSeen(pluginSeen);
    }

    public void removeListener(Listener l) {
        synchronized (listeners) {
            listeners.remove(l);
        }
    }

    public void attachActivity(MainActivity a) {
        this.activity = a;
    }

    public void detachActivity(MainActivity a) {
        if (this.activity == a) this.activity = null;
    }

    public MainActivity activity() {
        return activity;
    }

    /* ============================ 状态入口 ============================ */

    /** dsh 网页推来的权威状态（JS 接口 DshBallApp.post 的 type=state）。 */
    public void onWebState(JSONObject payload) {
        BallState s = BallState.wrap(payload, BallState.SRC_WEB);
        apply(s, true);
    }

    /** 宿主端点轮询来的状态（type=host state，优先级低于网页推送）。 */
    public void onHostState(JSONObject payload) {
        BallState s = BallState.wrap(payload, BallState.SRC_HOST);
        apply(s, false);
    }

    /** App 自己推断的状态（网页彻底失联时的兜底）。 */
    public void onNativeState(String emotion, String emotionName, boolean running) {
        try {
            JSONObject o = new JSONObject();
            o.put("emotion", emotion == null ? "" : emotion);
            o.put("emotionName", emotionName == null ? "" : emotionName);
            o.put("running", running);
            apply(BallState.wrap(o, BallState.SRC_NATIVE), true);
        } catch (Throwable t) {
            Log.w(TAG, "native state failed", t);
        }
    }

    private void apply(BallState s, boolean authoritative) {
        if (s == null) return;
        /* 网页推的状态永远覆盖宿主轮询；宿主轮询不许把网页的鲜活状态顶掉。 */
        BallState cur = this.state;
        if (!authoritative && cur != null && cur.src().equals(BallState.SRC_WEB)
                && System.currentTimeMillis() - lastPushAt < STALE_MS) {
            return;
        }
        this.state = s;
        this.lastPushAt = System.currentTimeMillis();

        String text = s.bubbleText();
        int seq = s.bubbleSeq();
        boolean newBubble = !text.isEmpty() && (seq < 0 ? !text.equals(bubbleText) : seq != bubbleSeq);
        if (newBubble) {
            bubbleText = text;
            bubbleSeq = seq;
        }

        main.post(() -> {
            List<Listener> copy;
            synchronized (listeners) {
                copy = new ArrayList<>(listeners);
            }
            for (Listener l : copy) {
                try {
                    l.onState(s);
                } catch (Throwable t) {
                    Log.w(TAG, "listener failed", t);
                }
            }
        });
    }

    public void onPluginSeen(final boolean seen) {
        if (pluginSeen == seen) return;
        pluginSeen = seen;
        main.post(() -> {
            List<Listener> copy;
            synchronized (listeners) {
                copy = new ArrayList<>(listeners);
            }
            for (Listener l : copy) {
                try {
                    l.onPluginSeen(seen);
                } catch (Throwable t) {
                    Log.w(TAG, "listener failed", t);
                }
            }
        });
    }

    /* ============================ 查询 ============================ */

    public BallState state() {
        return state;
    }

    public boolean pluginSeen() {
        return pluginSeen;
    }

    public boolean fresh() {
        return state != null && System.currentTimeMillis() - lastPushAt < STALE_MS;
    }

    public long lastPushAgo() {
        return lastPushAt == 0 ? -1 : System.currentTimeMillis() - lastPushAt;
    }

    public String bubbleText() {
        return bubbleText;
    }

    public boolean bubbleIsNew() {
        BallState s = state;
        return s != null && s.hasBubble();
    }

    /* ============================ Java -> 网页 ============================ */

    /** 把 host 信息推给网页（网页没有 __dshBallApp 时静默失败）。 */
    public void pushHostToWeb() {
        MainActivity a = activity;
        if (a == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("type", "host");
            o.put("keepAlive", KeepAliveService.isRunning());
            o.put("pluginSeen", pluginSeen);
            o.put("overlay", OverlayService.isRunning());
            o.put("ts", System.currentTimeMillis());
            a.evalJs("window.__dshBallApp && window.__dshBallApp.host && window.__dshBallApp.host("
                    + JSONObject.quote(o.toString()) + ")");
        } catch (Throwable t) {
            Log.w(TAG, "pushHostToWeb failed", t);
        }
    }

    /** 让网页里的表情球说一句（悬浮球单击/点它时用）。 */
    public void requestTaunt(String text) {
        MainActivity a = activity;
        if (a == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("type", "cmd");
            o.put("name", "say");
            if (text != null) o.put("text", text);
            a.evalJs("window.__dshBallApp && window.__dshBallApp.cmd && window.__dshBallApp.cmd("
                    + JSONObject.quote(o.toString()) + ")");
        } catch (Throwable t) {
            Log.w(TAG, "requestTaunt failed", t);
        }
    }

    /* ============================ 跨组件动作 ============================ */

    public void openApp(Context ctx) {
        try {
            Intent i = new Intent(ctx, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            ctx.startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "openApp failed", t);
        }
    }

    public void toast(String text) {
        MainActivity a = activity;
        if (a != null) a.toast(text);
    }
}
