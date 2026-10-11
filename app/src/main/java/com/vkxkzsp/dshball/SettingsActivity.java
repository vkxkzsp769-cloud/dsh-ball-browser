package com.vkxkzsp.dshball;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.ArrayAdapter;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;

/**
 * SettingsActivity —— 用纯框架控件搭的设置页（零第三方依赖）。
 */
public class SettingsActivity extends Activity {

    private LinearLayout box;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.parseColor("#12151B"));
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        box.setPadding(pad, pad, pad, dp(32));
        sv.addView(box);
        setContentView(sv);
        build();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView title(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.parseColor("#8FA3BF"));
        t.setTextSize(12.5f);
        t.setPadding(0, dp(18), 0, dp(6));
        return t;
    }

    private TextView note(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.parseColor("#66788F"));
        t.setTextSize(11.5f);
        t.setPadding(0, dp(2), 0, dp(6));
        return t;
    }

    private Switch toggle(String label, boolean value, boolean enabled,
                          android.widget.CompoundButton.OnCheckedChangeListener l) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextColor(Color.parseColor("#E6EBF2"));
        s.setTextSize(14f);
        s.setChecked(value);
        s.setEnabled(enabled);
        s.setPadding(0, dp(10), 0, dp(10));
        s.setOnCheckedChangeListener(l);
        box.addView(s);
        return s;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        box.addView(b, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }

    private SeekBar seek(int min, int max, int value, SeekBar.OnSeekBarChangeListener l) {
        SeekBar s = new SeekBar(this);
        s.setMax(max - min);
        s.setProgress(value - min);
        s.setOnSeekBarChangeListener(l);
        box.addView(s);
        return s;
    }

    private void build() {
        TextView h = new TextView(this);
        h.setText("dsh 表情球浏览器 · 设置");
        h.setTextColor(Color.parseColor("#F0F4F9"));
        h.setTextSize(19f);
        box.addView(h);
        box.addView(note("版本 " + versionName() + " · 悬浮球需要「显示在其他应用上层」权限"));

        /* ---------------- 连接 ---------------- */
        box.addView(title("dsh web 地址"));
        final EditText url = new EditText(this);
        url.setText(Prefs.baseUrl(this));
        url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        url.setTextColor(Color.parseColor("#E6EBF2"));
        url.setHint("http://127.0.0.1:3080");
        box.addView(url);
        box.addView(note("本机跑 dsh web 就用默认值；换设备才需要改 IP。"));
        button("保存并重新加载", v -> {
            String u = url.getText().toString().trim();
            Prefs.put(this, Prefs.BASE_URL, u.isEmpty() ? Prefs.DEFAULT_URL : u);
            Intent i = new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(i);
            finish();
        });

        /* ---------------- 悬浮球 ---------------- */
        box.addView(title("悬浮窗表情球"));
        toggle("开启悬浮球（切到别的应用也能看到它在干嘛）", Prefs.overlayOn(this), true, (b, on) -> {
            Prefs.put(this, Prefs.OVERLAY_ON, on);
            if (on) {
                if (!OverlayService.canDraw(this)) {
                    OverlayService.requestPermission(this);
                } else {
                    startService(new Intent(this, OverlayService.class)
                            .setAction(OverlayService.ACTION_SHOW));
                }
            } else {
                startService(new Intent(this, OverlayService.class)
                        .setAction(OverlayService.ACTION_HIDE));
            }
        });

        final TextView sizeLabel = note("大小 " + Prefs.overlaySize(this) + " px");
        box.addView(sizeLabel);
        seek(48, 160, Prefs.overlaySize(this), new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int p, boolean fromUser) {
                int v = 48 + p;
                sizeLabel.setText("大小 " + v + " px");
                Prefs.put(SettingsActivity.this, Prefs.OVERLAY_SIZE, v);
                OverlayService.refresh(SettingsActivity.this);
            }

            @Override public void onStartTrackingTouch(SeekBar sb) { }
            @Override public void onStopTrackingTouch(SeekBar sb) { }
        });

        box.addView(note("主题"));
        Spinner theme = new Spinner(this);
        ArrayAdapter<String> ta = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item, new String[]{"dark（黑球白瞳）", "cream（白球黑瞳）"});
        theme.setAdapter(ta);
        theme.setSelection("cream".equals(Prefs.overlayTheme(this)) ? 1 : 0);
        theme.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(android.widget.AdapterView<?> p, View v, int pos, long id) {
                Prefs.put(SettingsActivity.this, Prefs.OVERLAY_THEME, pos == 1 ? "cream" : "dark");
                OverlayService.refresh(SettingsActivity.this);
            }

            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        box.addView(theme);

        toggle("外观跟随网页里的表情球（大小/主题/气泡）", Prefs.useWebConfig(this), true,
                (b, on) -> {
                    Prefs.put(this, Prefs.USE_WEB_CONFIG, on);
                    OverlayService.refresh(SettingsActivity.this);
                });
        toggle("气泡说话（悬浮球旁边显示台词）", Prefs.bubbleOn(this), true,
                (b, on) -> Prefs.put(this, Prefs.BUBBLE_ON, on));
        toggle("网页断了时轮询 dsh 宿主兜底状态", Prefs.pollHost(this), true,
                (b, on) -> Prefs.put(this, Prefs.POLL_HOST, on));
        button("把球放回右下角", v -> {
            Prefs.sp(this).edit().remove(Prefs.OVERLAY_X).remove(Prefs.OVERLAY_Y).apply();
            OverlayService.refresh(this);
        });

        /* ---------------- 浏览器 ---------------- */
        box.addView(title("浏览器"));
        toggle("用桌面版 UA（页面太挤时可以试）", Prefs.desktopUa(this), true, (b, on) -> {
            Prefs.put(this, Prefs.DESKTOP_UA, on);
            toast("重新打开浏览器生效");
        });
        final TextView zoomLabel = note("页面缩放 " + Prefs.zoom(this) + "%");
        box.addView(zoomLabel);
        seek(50, 200, Prefs.zoom(this), new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int p, boolean fromUser) {
                int v = 50 + p;
                zoomLabel.setText("页面缩放 " + v + "%");
                Prefs.put(SettingsActivity.this, Prefs.ZOOM, v);
            }

            @Override public void onStartTrackingTouch(SeekBar sb) { }
            @Override public void onStopTrackingTouch(SeekBar sb) { }
        });

        /* ---------------- 保活 ---------------- */
        box.addView(title("保活（前台服务 + 常驻通知）"));
        toggle("常驻通知（安卓要求前台服务必须有通知）", Prefs.keepAliveNotif(this), true,
                (b, on) -> Prefs.put(this, Prefs.KEEPALIVE_NOTIF, on));
        box.addView(note("本版本不做开机自启、不做定时互拉。"));
        button("把本应用加入电池优化白名单", v -> {
            try {
                Prefs.put(this, "askedBattery", false);
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Throwable t) {
                toast("打不开白名单页面，请手动在系统设置里允许后台运行");
            }
        });

        /* ---------------- 权限 ---------------- */
        box.addView(title("权限状态"));
        refreshPermissionNote();

        /* ---------------- 诊断 ---------------- */
        box.addView(title("诊断"));
        button("查看崩溃日志", v -> showCrash());
        button("清空崩溃日志", v -> {
            try {
                new File(getFilesDir(), "crash.log").delete();
            } catch (Throwable ignored) {
            }
            toast("已清空");
        });
        button("停掉保活服务", v -> {
            stopService(new Intent(this, KeepAliveService.class));
            toast("已停（下次打开浏览器会重新启动）");
        });
    }

    private void refreshPermissionNote() {
        TextView t = note("悬浮窗权限：" + (OverlayService.canDraw(this) ? "已授权 ✓" : "未授权 ✗")
                + "\n保活服务：" + (KeepAliveService.isRunning() ? "运行中 ✓" : "未运行 ✗")
                + "\n悬浮球：" + (OverlayService.isRunning() ? "显示中 ✓" : "未显示")
                + "\n插件状态：" + (Bridge.get().pluginSeen() ? "已连接 ✓" : "未连接（网页里没装 dsh-ball-bridge 或页面没加载）")
                + "\n网页最近一次推送：" + (Bridge.get().lastPushAgo() < 0 ? "从未"
                : (Bridge.get().lastPushAgo() / 1000) + " 秒前"));
        box.addView(t);
    }

    private void showCrash() {
        try {
            File f = new File(getFilesDir(), "crash.log");
            if (!f.exists()) {
                toast("没有崩溃日志");
                return;
            }
            FileInputStream in = new FileInputStream(f);
            byte[] buf = new byte[(int) Math.min(f.length(), 20000)];
            int n = in.read(buf);
            in.close();
            String text = new String(buf, 0, Math.max(n, 0), "UTF-8");
            new android.app.AlertDialog.Builder(this)
                    .setTitle("崩溃日志")
                    .setMessage(text)
                    .setPositiveButton("知道了", null)
                    .show();
        } catch (Throwable t) {
            toast("读日志失败");
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "?";
        }
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }
}
