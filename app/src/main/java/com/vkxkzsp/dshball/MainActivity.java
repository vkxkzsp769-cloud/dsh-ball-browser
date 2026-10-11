package com.vkxkzsp.dshball;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * MainActivity —— 浏览器本体：一个 WebView 加载 dsh web。
 *
 * 关键点：本 Activity 被切到后台时**不暂停** WebView（不调 onPause/webview.onPause），
 * 让页面里的 WebSocket 与表情球继续跑，这样悬浮球才能一直有状态。
 */
public class MainActivity extends Activity implements Bridge.Listener {

    private static final String TAG = "DshBallMain";

    private WebView web;
    private ProgressBar bar;
    private FrameLayout root;
    private long lastBackAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0E1116"));

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 6);
        root.addView(bar, bp);

        setContentView(root);

        configureWebView();

        Bridge.get().attachActivity(this);
        Bridge.get().addListener(this);

        String url = Prefs.baseUrl(this);
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(url);
        }

        /* 保活服务：让进程活着，网页后台不断线 */
        BallApp.startKeepAlive(this);
        maybeAskOverlay();

        /* 屏幕常亮：看 dsh 的时候不要黑屏（可关，这里默认开，代价很低） */
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadsImagesAutomatically(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Prefs.desktopUa(this)) {
            s.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        }
        s.setTextZoom(Prefs.zoom(this));

        web.setBackgroundColor(Color.parseColor("#0E1116"));
        web.addJavascriptInterface(new WebBridge(this), WebBridge.NAME);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                bar.setProgress(p);
                bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleUrl(req.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                /* 页面换了：插件是否在线要重新判断，顺手把 host 信息推一次 */
                Bridge.get().onPluginSeen(false);
                Bridge.get().pushHostToWeb();
                injectBridgeHint();
            }
        });
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    }

    /** 非本机地址交给系统浏览器（dsh 内部链接仍留在 WebView 里）。 */
    private boolean handleUrl(String url) {
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost() == null ? "" : u.getHost();
            boolean local = host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1");
            if (url.startsWith("http") && !local) {
                openExternal(url);
                return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            toast("打不开链接：" + url);
        }
    }

    /** 给页面塞一个「App 在不在」的标记，插件可以据此决定要不要推状态。 */
    private void injectBridgeHint() {
        evalJs("window.__dshBallAppHost = { app: 'dsh-ball-browser', v: "
                + BallState.VERSION + ", keepAlive: " + KeepAliveService.isRunning()
                + ", overlay: " + OverlayService.isRunning() + " };");
    }

    /**
     * 让页面替我们去宿主端点要一次状态（同源 + 带 cookie，不用自己造一套鉴权），
     * 拿到后由页面通过 DshBallApp.post 回传。后台 JS 定时器被系统节流时，
     * 由保活服务定期调这个方法强制跑一次。
     */
    public void requestHostResync() {
        evalJs("(function(){try{"
                + "var rid='rs-'+Date.now().toString(36);"
                + "fetch('/dsh-ball-bridge/status',{method:'POST',"
                + "headers:{'content-type':'application/json'},"
                + "body:JSON.stringify({rpcId:rid,type:'client-request',"
                + "method:'dsh-ball-bridge/status',payload:{}}),credentials:'same-origin'})"
                + ".then(function(r){return r.json()}).then(function(j){"
                + "var st=j&&((j.value&&j.value.state)||j.state);"
                + "if(st&&window." + WebBridge.NAME + "){window." + WebBridge.NAME
                + ".post(JSON.stringify({type:'state',state:st}))}"
                + "}).catch(function(){})}catch(e){}})();");
    }

    public void evalJs(String js) {
        try {
            web.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "evalJs failed", t);
        }
    }

    public void toast(String text) {
        if (text == null || text.isEmpty()) return;
        runOnUiThread(() -> {
            try {
                Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
            } catch (Throwable ignored) {
            }
        });
    }

    /** 悬浮窗权限：没有就引导去开（只在第一次启动提示）。 */
    private void maybeAskOverlay() {
        if (!Prefs.overlayOn(this)) return;
        if (OverlayService.canDraw(this)) {
            startOverlay();
            return;
        }
        if (Prefs.sp(this).getBoolean("askedOverlay", false)) return;
        Prefs.put(this, "askedOverlay", true);
        new android.app.AlertDialog.Builder(this)
                .setTitle("需要悬浮窗权限")
                .setMessage("表情球要浮在浏览器上面（这样你切到别的应用也能看到它在想什么），"
                        + "需要「显示在其他应用上层」权限。")
                .setPositiveButton("去授权", (d, w) -> OverlayService.requestPermission(this))
                .setNegativeButton("以后再说", null)
                .show();
    }

    private void startOverlay() {
        if (!Prefs.overlayOn(this)) return;
        try {
            Intent i = new Intent(this, OverlayService.class);
            i.setAction(OverlayService.ACTION_SHOW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
            else startService(i);
        } catch (Throwable t) {
            Log.w(TAG, "startOverlay failed", t);
        }
    }

    /* ============================ Bridge.Listener ============================ */

    @Override
    public void onState(BallState state) {
        /* 悬浮窗由 OverlayService 自己订阅 Bridge，这里不用转发 */
    }

    @Override
    public void onPluginSeen(boolean seen) {
        if (!seen) return;
        runOnUiThread(() -> toast("已连上 dsh 表情球插件"));
    }

    /* ============================ 生命周期 ============================ */

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && "overlaySettings".equals(intent.getStringExtra("open"))) {
            startActivity(new Intent(this, SettingsActivity.class));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        Bridge.get().pushHostToWeb();
        if (Prefs.overlayOn(this) && OverlayService.canDraw(this)) startOverlay();
    }

    @Override
    protected void onPause() {
        /* 故意不调用 web.onPause()：后台也要继续收 dsh 的状态推送 */
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        Bridge.get().removeListener(this);
        Bridge.get().detachActivity(this);
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        Bridge.get().pushHostToWeb();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            /* 先关设置面板/悬浮球，再退出 */
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 2000) {
                moveTaskToBack(true);
                return true;
            }
            lastBackAt = now;
            toast("再按一次回到桌面（保活继续）");
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /* ============================ 给悬浮球用的小工具 ============================ */

    /** 打开设置页（悬浮球长按会调这里）。 */
    public void openSettings() {
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(this, SettingsActivity.class));
            } catch (Throwable t) {
                Log.w(TAG, "openSettings failed", t);
            }
        });
    }

    /** 悬浮球单击：让网页里的球也说一句（保持同一个性格）。 */
    public void onOverlayTap() {
        Bridge.get().requestTaunt(null);
    }
}
