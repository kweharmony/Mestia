package com.mestia.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground-сервис на время загрузок: без него Android убивает процесс yt-dlp,
 * как только приложение уходит в фон. Счётчик активных загрузок общий; сервис
 * сам останавливается, когда он обнуляется.
 */
class DownloadService : Service() {
    companion object {
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 1
        private val active = AtomicInteger(0)

        @Volatile
        private var instance: DownloadService? = null

        fun begin(ctx: Context) {
            if (active.incrementAndGet() != 1) return
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java))
            } catch (e: Exception) {
                // Запуск из фона запрещён (Android 12+) — загрузка всё равно идёт,
                // просто без защиты от выгрузки.
            }
        }

        fun end(ctx: Context) {
            if (active.decrementAndGet() > 0) return
            active.set(0)
            // stopService до startForeground уронил бы приложение — сервис гасит себя сам.
            instance?.stopIfIdle()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
        // startForeground обязателен в первые секунды после startForegroundService.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        stopIfIdle() // загрузки могли закончиться, пока сервис запускался
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    // Android 15: лимит времени dataSync исчерпан — останавливаемся корректно.
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopIfIdle(force = true)
    }

    private fun stopIfIdle(force: Boolean = false) {
        if (!force && active.get() > 0) return
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.downloads_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.downloads_running))
            .setOngoing(true)
            .setContentIntent(open)
            .setProgress(0, 0, true)
            .build()
    }
}
