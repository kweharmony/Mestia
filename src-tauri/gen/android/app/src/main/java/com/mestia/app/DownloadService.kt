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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground-сервис на время загрузок: без него Android убивает процесс yt-dlp,
 * как только приложение уходит в фон. Счётчик активных загрузок общий; сервис
 * сам останавливается, когда он обнуляется. В уведомлении — процент готового файла
 * (одна загрузка) или средний по всем.
 */
class DownloadService : Service() {
    companion object {
        private const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 1
        private val active = AtomicInteger(0)

        /** id загрузки → (название, процент). */
        private val percents = ConcurrentHashMap<String, Pair<String?, Int>>()

        @Volatile
        private var instance: DownloadService? = null

        /** Идущие загрузки: поздний процент от уже закончившейся не воскресит её в уведомлении. */
        private val running = ConcurrentHashMap.newKeySet<String>()

        fun begin(ctx: Context, id: String) {
            running.add(id)
            if (active.incrementAndGet() != 1) return
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java))
            } catch (e: Exception) {
                // Запуск из фона запрещён (Android 12+) — загрузка всё равно идёт,
                // просто без защиты от выгрузки.
            }
        }

        fun progress(id: String, title: String?, percent: Int) {
            if (id !in running) return
            percents[id] = title to percent.coerceIn(0, 100)
            instance?.let { svc -> svc.handler.post { svc.renotify() } }
        }

        fun end(ctx: Context, id: String) {
            running.remove(id)
            percents.remove(id)
            instance?.let { svc -> svc.handler.post { svc.renotify() } }
            if (active.decrementAndGet() > 0) return
            active.set(0)
            // stopService до startForeground уронил бы приложение — сервис гасит себя сам.
            instance?.stopIfIdle()
        }
    }

    private val handler = Handler(Looper.getMainLooper())

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

    private fun renotify() {
        if (instance !== this || active.get() == 0) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
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
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(open)
        val items = percents.values.toList()
        if (items.isEmpty()) {
            return b.setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.downloads_running))
                .setProgress(0, 0, true)
                .build()
        }
        val pct = items.sumOf { it.second } / items.size
        val title = if (items.size == 1) items[0].first ?: getString(R.string.downloads_running)
        else getString(R.string.downloads_many, items.size)
        return b.setContentTitle(title)
            .setContentText("$pct%")
            .setSubText(getString(R.string.app_name))
            .setProgress(100, pct, false)
            .build()
    }
}
