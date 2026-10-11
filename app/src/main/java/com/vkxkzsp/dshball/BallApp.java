package com.vkxkzsp.dshball;

import android.app.Application;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * BallApp —— 应用入口：装一个把崩溃写到文件的兜底，方便在手机上排查。
 */
public class BallApp extends Application {

    private static BallApp self;

    public static BallApp get() {
        return self;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        self = this;
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            writeCrash(e);
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    /** 崩溃日志写到私有目录，设置页里可以看/清。 */
    public static void writeCrash(Throwable e) {
        try {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            String line = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date())
                    + "  " + sw + "\n\n";
            File f = new File(BallApp.get().getFilesDir(), "crash.log");
            try (FileOutputStream out = new FileOutputStream(f, true)) {
                out.write(line.getBytes("UTF-8"));
            }
        } catch (Throwable ignored) {
        }
    }

    public static void log(String msg) {
        Log.i(Bridge.TAG, msg);
    }

    /** 让保活服务起来（幂等；Android 8+ 一律 startForegroundService）。 */
    public static void startKeepAlive(android.content.Context ctx) {
        try {
            Intent i = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Throwable t) {
            Log.w(Bridge.TAG, "startKeepAlive failed", t);
        }
    }
}
