package com.vkxkzsp.dshball;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Prefs —— 设置项（键名与 docs/INTERFACES.md 第 7 节一致）。
 */
public final class Prefs {

    private static final String FILE = "dsh_ball_prefs";

    public static final String BASE_URL = "baseUrl";
    public static final String OVERLAY_ON = "overlayOn";
    public static final String OVERLAY_SIZE = "overlaySize";
    public static final String OVERLAY_THEME = "overlayTheme";
    public static final String OVERLAY_X = "overlayX";
    public static final String OVERLAY_Y = "overlayY";
    public static final String USE_WEB_CONFIG = "useWebConfig";
    public static final String POLL_HOST = "pollHostStatus";
    public static final String BUBBLE_ON = "bubbleOn";
    public static final String KEEPALIVE_NOTIF = "keepAliveNotif";
    public static final String DESKTOP_UA = "userAgentDesktop";
    public static final String ZOOM = "zoom";
    public static final String PRICING_ANCHOR = "pricingAnchor";
    public static final String SEEN_TIPS = "seenTips";

    public static final String DEFAULT_URL = "http://127.0.0.1:3080";

    private Prefs() {
    }

    public static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static String baseUrl(Context c) {
        String v = sp(c).getString(BASE_URL, DEFAULT_URL);
        if (v == null || v.trim().isEmpty()) v = DEFAULT_URL;
        v = v.trim();
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        return v;
    }

    public static boolean overlayOn(Context c) {
        return sp(c).getBoolean(OVERLAY_ON, true);
    }

    public static int overlaySize(Context c) {
        return clamp(sp(c).getInt(OVERLAY_SIZE, 96), 48, 160);
    }

    public static String overlayTheme(Context c) {
        return sp(c).getString(OVERLAY_THEME, "dark");
    }

    public static boolean useWebConfig(Context c) {
        return sp(c).getBoolean(USE_WEB_CONFIG, true);
    }

    public static boolean pollHost(Context c) {
        return sp(c).getBoolean(POLL_HOST, true);
    }

    public static boolean bubbleOn(Context c) {
        return sp(c).getBoolean(BUBBLE_ON, true);
    }

    public static boolean keepAliveNotif(Context c) {
        return sp(c).getBoolean(KEEPALIVE_NOTIF, true);
    }

    public static boolean desktopUa(Context c) {
        return sp(c).getBoolean(DESKTOP_UA, false);
    }

    public static int zoom(Context c) {
        return clamp(sp(c).getInt(ZOOM, 100), 50, 200);
    }

    public static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    public static void put(Context c, String k, boolean v) {
        sp(c).edit().putBoolean(k, v).apply();
    }

    public static void put(Context c, String k, int v) {
        sp(c).edit().putInt(k, v).apply();
    }

    public static void put(Context c, String k, String v) {
        sp(c).edit().putString(k, v).apply();
    }
}
