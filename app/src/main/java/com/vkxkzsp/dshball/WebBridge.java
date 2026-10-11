package com.vkxkzsp.dshball;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * WebBridge —— 注入主 WebView 的 JS 接口（契约第 3.1 节），名字固定 DshBallApp。
 *
 * 页面侧：window.DshBallApp.post(jsonString)
 * 这里的所有异常都吞掉：桥坏掉不许影响 dsh 本体。
 */
public class WebBridge {

    public static final String NAME = "DshBallApp";

    private final MainActivity activity;

    public WebBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void post(String json) {
        try {
            if (json == null || json.isEmpty()) return;
            JSONObject o = new JSONObject(json);
            String type = o.optString("type", "");
            Bridge b = Bridge.get();
            switch (type) {
                case "state": {
                    JSONObject payload = o.optJSONObject("state");
                    b.onWebState(payload != null ? payload : o);
                    break;
                }
                case "hello": {
                    b.onPluginSeen(true);
                    b.pushHostToWeb();
                    break;
                }
                case "open": {
                    String url = o.optString("url", "");
                    if (!url.isEmpty()) activity.openExternal(url);
                    break;
                }
                case "toast": {
                    b.toast(o.optString("text", ""));
                    break;
                }
                case "log": {
                    BallApp.log("web: " + o.optString("text", ""));
                    break;
                }
                default:
                    break;
            }
        } catch (Throwable t) {
            // 静默：桥的任何问题都不许影响页面
        }
    }

    /** 页面卸载时告诉 App 一声，方便把 pluginSeen 复位。 */
    @JavascriptInterface
    public void bye() {
        try {
            Bridge.get().onPluginSeen(false);
        } catch (Throwable ignored) {
        }
    }
}
