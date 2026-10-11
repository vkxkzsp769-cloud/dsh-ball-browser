package com.vkxkzsp.dshball;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

/**
 * KeepAliveService —— 保活（契约第 7 节：前台服务 + 常驻通知 + 电池优化白名单引导）。
 *
 * 做：
 *   - 前台服务常驻，进程不被系统随手回收，网页的后台连接不断线；
 *   - 通知里能一键开关悬浮球、进设置、退出保活；
 *   - 引导用户把本应用加入电池优化白名单（不做开机自启、不做 Alarm 互拉）。
 * 不做：开机自启、WakeLock 常驻、定时互拉。
 */
public class KeepAliveService extends Service {

    public static final String CHANNEL_ID = "dsh-ball-keepalive";
    public static final int NOTIF_ID = 1001;

    public static final String ACTION_START = "com.vkxkzsp.dshball.KEEPALIVE_START";
    public static final String ACTION_STOP = "com.vkxkzsp.dshball.KEEPALIVE_STOP";
    public static final String ACTION_TOGGLE_OVERLAY = "com.vkxkzsp.dshball.TOGGLE_OVERLAY";
    public static final String ACTION_SETTINGS = "com.vkxkzsp.dshball.OPEN_SETTINGS";

    private static volatile boolean running = false;

    /** 定期「叫醒页面」：安卓在后台会节流网页里的定时器，这里从原生侧主动推一把。 */
    private static final long NUDGE_MS = 15_000L;
    private final Handler tick = new Handler(Looper.getMainLooper());
    private final Runnable nudge = new Runnable() {
        @Override
        public void run() {
            try {
                Bridge b = Bridge.get();
                b.pushHostToWeb();
                if (!b.fresh()) {
                    MainActivity a = b.activity();
                    if (a != null) a.requestHostResync();
                }
            } catch (Throwable ignored) {
            }
            tick.postDelayed(this, NUDGE_MS);
        }
    };

    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            running = false;
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE_OVERLAY.equals(action)) {
            boolean on = !Prefs.overlayOn(this);
            Prefs.put(this, Prefs.OVERLAY_ON, on);
            if (on) {
                if (OverlayService.canDraw(this)) {
                    startService(new Intent(this, OverlayService.class)
                            .setAction(OverlayService.ACTION_SHOW));
                } else {
                    OverlayService.requestPermission(this);
                }
            } else {
                startService(new Intent(this, OverlayService.class)
                        .setAction(OverlayService.ACTION_HIDE));
            }
        }
        if (ACTION_SETTINGS.equals(action)) {
            Bridge.get().openApp(this);
        }

        running = true;
        startForeground(NOTIF_ID, buildNotification());
        tick.removeCallbacks(nudge);
        if (Prefs.pollHost(this)) tick.postDelayed(nudge, 5_000L);
        ensureIgnoringBatteryOptimizations();
        Log.i(Bridge.TAG, "KeepAliveService started");
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        tick.removeCallbacks(nudge);
        super.onDestroy();
    }

    /* ============================ 通知 ============================ */

    public static void createChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "表情球保活",
                NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("让 dsh 网页在后台保持连接，并把表情球浮在屏幕上");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent servicePI(String action, int req) {
        Intent i = new Intent(this, KeepAliveService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, req, i, flags);
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent openPI = PendingIntent.getActivity(this, 1, open, flags);

        boolean overlay = Prefs.overlayOn(this);
        b.setSmallIcon(android.R.drawable.ic_menu_compass)
                .setContentTitle("dsh 表情球在后台看着呢")
                .setContentText(overlay ? "悬浮球已开启 · 点一下回浏览器" : "悬浮球已关闭 · 点一下回浏览器")
                .setContentIntent(openPI)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(Notification.PRIORITY_MIN)
                .addAction(new Notification.Action.Builder(
                        null, overlay ? "关掉悬浮球" : "打开悬浮球",
                        servicePI(ACTION_TOGGLE_OVERLAY, 2)).build())
                .addAction(new Notification.Action.Builder(
                        null, "退出保活", servicePI(ACTION_STOP, 3)).build());
        return b.build();
    }

    /** 引导加入电池优化白名单（不做强制，失败就算了）。 */
    private void ensureIgnoringBatteryOptimizations() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            if (Prefs.sp(this).getBoolean("askedBattery", false)) return;
            Prefs.put(this, "askedBattery", true);
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            Log.w(Bridge.TAG, "battery whitelist prompt failed", t);
        }
    }
}
