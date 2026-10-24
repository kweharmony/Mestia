package com.mestia.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground-сервис на время воспроизведения (плеер и «Смотреть вместе»): с выключенным
 * экраном Android иначе усыпляет процессор и Wi-Fi — звук обрывается, поток с другого
 * устройства перестаёт приходить. Держит partial wake lock и Wi-Fi lock.
 */
class PlaybackService : Service() {
    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 2

        @Volatile
        private var wanted = false

        @Volatile
        private var instance: PlaybackService? = null

        fun set(ctx: Context, on: Boolean) {
            if (wanted == on) return
            wanted = on
            if (on) {
                try {
                    ContextCompat.startForegroundService(ctx, Intent(ctx, PlaybackService::class.java))
                } catch (e: Exception) {
                    // Запуск из фона запрещён (Android 12+) — играем без защиты от сна.
                    wanted = false
                }
            } else {
                // stopService до startForeground уронил бы приложение — сервис гасит себя сам.
                instance?.stopIfIdle()
            }
        }
    }

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mestia:playback")
                .apply { setReferenceCounted(false); acquire() }
        }
        if (wifi == null) {
            @Suppress("DEPRECATION")
            wifi = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "mestia:playback")
                .apply { setReferenceCounted(false); acquire() }
        }
        stopIfIdle() // воспроизведение могло закончиться, пока сервис запускался
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        runCatching { wake?.release() }
        runCatching { wifi?.release() }
        wake = null
        wifi = null
        instance = null
        super.onDestroy()
    }

    private fun stopIfIdle() {
        if (wanted) return
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.playback_running))
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
