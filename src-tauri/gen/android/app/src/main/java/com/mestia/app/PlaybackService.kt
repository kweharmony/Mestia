package com.mestia.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.MediaMetadataRetriever
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.JSObject
import java.io.File
import java.net.URL
import java.util.concurrent.Executors

/** Что сейчас играет в плеере Mestia — для уведомления и системной медиапанели. */
class NowPlaying(
    val title: String,
    val artist: String?,
    /** Обложка: путь к файлу или http(s)-адрес; нет — кадр/обложка из самого медиафайла. */
    val artwork: String?,
    val path: String?,
    val durationMs: Long,
    val positionMs: Long,
    val playing: Boolean,
    val rate: Float,
    val hasPrev: Boolean,
    val hasNext: Boolean,
)

/**
 * Foreground-сервис воспроизведения. Две роли:
 * 1. Плеер: MediaSession + уведомление-медиапанель (название, обложка, полоса времени,
 *    ⏮ ⏯ ⏭) — как у музыкальных приложений; кнопки уходят во фронтенд (onAction).
 * 2. «Смотреть вместе» (set): просто не дать телефону уснуть.
 * Пока что-то играет, держит partial wake lock и Wi-Fi lock: с выключенным экраном
 * Android иначе усыпляет процессор и сеть — звук обрывается, поток перестаёт приходить.
 */
class PlaybackService : Service() {
    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 2
        private const val ACTION_PLAY = "com.mestia.app.PLAY"
        private const val ACTION_PAUSE = "com.mestia.app.PAUSE"
        private const val ACTION_NEXT = "com.mestia.app.NEXT"
        private const val ACTION_PREV = "com.mestia.app.PREV"

        @Volatile
        private var keepAlive = false

        @Volatile
        private var nowPlaying: NowPlaying? = null

        @Volatile
        private var instance: PlaybackService? = null

        /** Нажатия в уведомлении/на гарнитуре → фронтенд ({action, position?}). */
        @Volatile
        var onAction: ((JSObject) -> Unit)? = null

        /** «Смотреть вместе» играет — держать процессор и Wi-Fi. */
        fun set(ctx: Context, on: Boolean) {
            if (keepAlive == on) return
            keepAlive = on
            sync(ctx)
        }

        /** Состояние плеера (null — плеер закрыт). */
        fun update(ctx: Context, np: NowPlaying?) {
            nowPlaying = np
            sync(ctx)
        }

        /** Сейчас что-то играет (MainActivity не даёт WebView ставить паузу при выключении экрана). */
        fun isPlaying(): Boolean = keepAlive || nowPlaying?.playing == true

        private fun wanted() = keepAlive || nowPlaying != null

        private fun sync(ctx: Context) {
            val svc = instance
            if (svc != null) {
                svc.handler.post { svc.refresh() }
                return
            }
            if (!wanted()) return
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, PlaybackService::class.java))
            } catch (e: Exception) {
                // Запуск из фона запрещён (Android 12+) — играем без уведомления и защиты от сна.
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var session: MediaSession? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    // Обложка текущего трека и то, из чего она получена (чтобы не грузить заново).
    private var art: Bitmap? = null
    private var artKey: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> emit("play")
            ACTION_PAUSE -> emit("pause")
            ACTION_NEXT -> emit("next")
            ACTION_PREV -> emit("prev")
        }
        // startForeground обязателен в первые секунды после startForegroundService.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        refresh() // воспроизведение могло закончиться, пока сервис запускался
        return START_NOT_STICKY
    }

    // Приложение смахнули из недавних — WebView с плеером больше нет.
    override fun onTaskRemoved(rootIntent: Intent?) {
        keepAlive = false
        nowPlaying = null
        refresh()
    }

    override fun onDestroy() {
        locks(false)
        session?.release()
        session = null
        io.shutdownNow()
        instance = null
        super.onDestroy()
    }

    /** Привести сервис, блокировки, сессию и уведомление к текущему состоянию. */
    private fun refresh() {
        if (!wanted()) {
            // Отвязываемся сразу: новый трек до onDestroy должен поднять новый сервис.
            instance = null
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        locks(isPlaying())
        val np = nowPlaying
        if (np != null) {
            updateSession(np)
            loadArt(np)
        } else {
            session?.isActive = false
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun locks(on: Boolean) {
        if (on) {
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
        } else {
            runCatching { wake?.release() }
            runCatching { wifi?.release() }
            wake = null
            wifi = null
        }
    }

    private fun emit(action: String, positionMs: Long? = null) {
        val msg = JSObject().put("action", action)
        if (positionMs != null) msg.put("position", positionMs / 1000.0)
        onAction?.invoke(msg)
    }

    private fun ensureSession(): MediaSession =
        session ?: MediaSession(this, "mestia").also { s ->
            s.setCallback(object : MediaSession.Callback() {
                override fun onPlay() = emit("play")
                override fun onPause() = emit("pause")
                override fun onStop() = emit("pause")
                override fun onSkipToNext() = emit("next")
                override fun onSkipToPrevious() = emit("prev")
                override fun onSeekTo(pos: Long) = emit("seek", pos)
            }, handler)
            s.setSessionActivity(openAppIntent())
            session = s
        }

    private fun updateSession(np: NowPlaying) {
        val s = ensureSession()
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, np.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, np.artist ?: getString(R.string.app_name))
                .putLong(MediaMetadata.METADATA_KEY_DURATION, np.durationMs)
                .apply { art?.let { putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) } }
                .build()
        )
        var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
        if (np.hasNext) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT
        if (np.hasPrev) actions = actions or PlaybackState.ACTION_SKIP_TO_PREVIOUS
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(
                    if (np.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    np.positionMs,
                    if (np.playing) np.rate else 0f,
                    SystemClock.elapsedRealtime(),
                )
                .build()
        )
        s.isActive = true
    }

    /** Обложка — в фоне; готова → обновляем сессию и уведомление. */
    private fun loadArt(np: NowPlaying) {
        val key = np.artwork ?: np.path
        if (key == artKey) return
        artKey = key
        art = null
        if (key == null) return
        io.execute {
            val bmp = runCatching { decodeArt(np.artwork) }.getOrNull()
                ?: runCatching { artFromMedia(np.path) }.getOrNull()
            handler.post {
                if (artKey == key && bmp != null) {
                    art = bmp
                    refresh()
                }
            }
        }
    }

    private fun decodeArt(src: String?): Bitmap? {
        if (src.isNullOrEmpty()) return null
        if (src.startsWith("http://") || src.startsWith("https://")) {
            val conn = URL(src).openConnection().apply { connectTimeout = 5000; readTimeout = 5000 }
            return conn.getInputStream().use { scaled(it.readBytes()) }
        }
        return File(src).takeIf { it.isFile }?.let { scaled(it.readBytes()) }
    }

    /** Аудио — встроенная обложка, видео — кадр с 3-й секунды. */
    private fun artFromMedia(path: String?): Bitmap? {
        if (path.isNullOrEmpty()) return null
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(path)
            r.embeddedPicture?.let { return scaled(it) }
            val frame = r.getFrameAtTime(3_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: r.getFrameAtTime(0) ?: return null
            return shrink(frame)
        } finally {
            runCatching { r.release() }
        }
    }

    private fun scaled(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 512) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        return bmp?.let { shrink(it) }
    }

    private fun shrink(b: Bitmap): Bitmap {
        val side = maxOf(b.width, b.height)
        if (side <= 512) return b
        val k = 512f / side
        return Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true)
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE
    )

    private fun buttonIntent(action: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code, Intent(this, PlaybackService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE
    )

    private fun button(icon: Int, title: Int, action: String, code: Int): Notification.Action =
        Notification.Action.Builder(Icon.createWithResource(this, icon), getString(title), buttonIntent(action, code)).build()

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val b = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mestia)
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setShowWhen(false)
        val np = nowPlaying
        val s = session
        if (np == null || s == null) {
            return b.setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.playback_running))
                .build()
        }
        // Кнопки уведомления нужны до Android 13; с 13 панель строится по PlaybackState.
        val compact = mutableListOf<Int>()
        if (np.hasPrev) {
            b.addAction(button(android.R.drawable.ic_media_previous, R.string.media_prev, ACTION_PREV, 1))
            compact.add(compact.size)
        }
        b.addAction(
            if (np.playing) button(android.R.drawable.ic_media_pause, R.string.media_pause, ACTION_PAUSE, 2)
            else button(android.R.drawable.ic_media_play, R.string.media_play, ACTION_PLAY, 3)
        )
        compact.add(compact.size)
        if (np.hasNext) {
            b.addAction(button(android.R.drawable.ic_media_next, R.string.media_next, ACTION_NEXT, 4))
            compact.add(compact.size)
        }
        return b.setContentTitle(np.title)
            .setContentText(np.artist ?: getString(R.string.app_name))
            .setLargeIcon(art)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(s.sessionToken)
                    .setShowActionsInCompactView(*compact.toIntArray())
            )
            .build()
    }
}
