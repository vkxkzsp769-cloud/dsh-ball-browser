package com.vkxkzsp.dshball;

import org.json.JSONObject;

/**
 * BallState —— 三方共用的状态信封（见 docs/INTERFACES.md 第 1 节）。
 *
 * 这里刻意做成「弱类型 + 全字段兜底」：任何一个字段缺失/类型不对都不许崩，
 * 因为它是插件、App、悬浮窗页三边唯一的耦合点。
 */
public final class BallState {

    public static final int VERSION = 1;

    /** 状态来源：页面推的（权威） / 宿主端点 / App 自己推断。 */
    public static final String SRC_WEB = "web";
    public static final String SRC_HOST = "host";
    public static final String SRC_NATIVE = "native";

    private final JSONObject raw;

    private BallState(JSONObject raw) {
        this.raw = raw;
    }

    /** 从任意 JSON 文本解析；失败返回 null（调用方自己决定兜底）。 */
    public static BallState parse(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONObject obj = new JSONObject(json);
            return new BallState(obj);
        } catch (Throwable t) {
            return null;
        }
    }

    public static BallState wrap(JSONObject obj, String src) {
        JSONObject copy = obj == null ? new JSONObject() : new JSONObject(obj.toString());
        try {
            copy.put("v", VERSION);
            if (src != null) copy.put("src", src);
            copy.put("ts", System.currentTimeMillis());
        } catch (Throwable ignored) {
        }
        return new BallState(copy);
    }

    public JSONObject json() {
        return raw;
    }

    public String toJson() {
        return raw.toString();
    }

    public String str(String key, String def) {
        String v = raw.optString(key, def);
        return v == null ? def : v;
    }

    public boolean bool(String key, boolean def) {
        return raw.optBoolean(key, def);
    }

    public int integer(String key, int def) {
        return raw.optInt(key, def);
    }

    public JSONObject obj(String key) {
        JSONObject o = raw.optJSONObject(key);
        return o == null ? new JSONObject() : o;
    }

    public long ts() {
        return raw.optLong("ts", 0L);
    }

    public String src() {
        return str("src", "");
    }

    /** 当前要显示的表情 ID（两位字符串），空串表示未知。 */
    public String emotion() {
        String e = str("emotion", "");
        if (e.isEmpty()) e = str("mood", "");
        if (e.isEmpty()) e = str("taskMood", "");
        return e;
    }

    public String emotionName() {
        return str("emotionName", "");
    }

    public boolean running() {
        return bool("running", false);
    }

    /** 气泡文本，没有则空串。 */
    public String bubbleText() {
        JSONObject b = raw.optJSONObject("bubble");
        if (b == null) return "";
        return b.optString("text", "");
    }

    public int bubbleSeq() {
        JSONObject b = raw.optJSONObject("bubble");
        if (b == null) return -1;
        return b.optInt("seq", -1);
    }

    public String pricingLabel() {
        JSONObject p = raw.optJSONObject("pricing");
        if (p == null) return "";
        return p.optString("label", "");
    }

    /** 页面里表情球的配置（只读参考，用于对齐悬浮球外观）。 */
    public JSONObject cfg() {
        return obj("cfg");
    }

    public boolean hasBubble() {
        return !bubbleText().isEmpty();
    }
}
