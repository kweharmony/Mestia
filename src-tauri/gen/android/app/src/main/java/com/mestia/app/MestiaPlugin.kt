package com.mestia.app

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.os.Environment
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

@InvokeArg
class ExecArgs {
    lateinit var id: String
    var args: Array<String> = arrayOf()
    var keepAlive: Boolean = false
    lateinit var channel: Channel
}

@InvokeArg
class IdArgs {
    lateinit var id: String
}

@InvokeArg
class PathArgs {
    lateinit var path: String
}

@InvokeArg
class ThumbArgs {
    lateinit var videoPath: String
    lateinit var outPath: String
}

/**
 * Android-часть Mestia (Rust-сторона — src-tauri/src/mobile.rs и engine.rs).
 * yt-dlp, Python и ffmpeg — из youtubedl-android; аргументы собирает общий Rust-код,
 * здесь только запуск процесса, построчная передача вывода и платформенные мелочи.
 */
@TauriPlugin
class MestiaPlugin(private val activity: Activity) : Plugin(activity) {
    // Процессы yt-dlp живут долго — не держим ими поток вызова плагина.
    private val pool = Executors.newCachedThreadPool()

    @Volatile
    private var ready = false

    // Ссылка из «Поделиться», которую фронтенд ещё не забрал.
    @Volatile
    private var sharedText: String? = null

    override fun load(webView: WebView) {
        super.load(webView)
        captureShare(activity.intent)
        // Распаковка Python занимает секунды — начинаем сразу, не дожидаясь первой загрузки.
        pool.execute { runCatching { ensureInit() } }
    }

    override fun onNewIntent(intent: Intent) {
        captureShare(intent)
    }

    private fun captureShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        if (!text.isNullOrEmpty()) sharedText = text
    }

    @Synchronized
    private fun ensureInit() {
        if (ready) return
        val ctx = activity.applicationContext
        YoutubeDL.getInstance().init(ctx)
        FFmpeg.getInstance().init(ctx)
        ready = true
    }

    /** Запуск yt-dlp: строки stdout — в канал по мере появления, итог — {code, stderr}. */
    @Command
    fun execute(invoke: Invoke) {
        val a = invoke.parseArgs(ExecArgs::class.java)
        pool.execute {
            if (a.keepAlive) DownloadService.begin(activity)
            try {
                ensureInit()
                val request = YoutubeDLRequest(emptyList<String>()).addCommands(a.args.toList())
                val response = YoutubeDL.getInstance().execute(request, a.id) { _, _, line ->
                    a.channel.send(JSObject().put("line", line))
                }
                invoke.resolve(JSObject().put("code", response.exitCode).put("stderr", response.err))
            } catch (e: YoutubeDL.CanceledException) {
                // code отсутствует → для Rust это «убит/отменён».
                invoke.resolve(JSObject().put("stderr", ""))
            } catch (e: YoutubeDLException) {
                // Ненулевой код выхода: в сообщении — stderr yt-dlp (там строки ERROR).
                invoke.resolve(JSObject().put("code", 1).put("stderr", e.message ?: ""))
            } catch (e: Exception) {
                invoke.reject(e.message ?: e.toString())
            } finally {
                if (a.keepAlive) DownloadService.end(activity)
            }
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        YoutubeDL.getInstance().destroyProcessById(a.id)
        invoke.resolve()
    }

    /** Обновить встроенный yt-dlp до свежего стабильного релиза. */
    @Command
    fun update(invoke: Invoke) {
        pool.execute {
            try {
                ensureInit()
                val ctx = activity.applicationContext
                YoutubeDL.getInstance().updateYoutubeDL(ctx, YoutubeDL.UpdateChannel.STABLE)
                invoke.resolve(JSObject().put("version", YoutubeDL.getInstance().versionName(ctx) ?: ""))
            } catch (e: Exception) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    /**
     * Папка загрузок: Download/Mestia. С Android 11 приложение пишет туда без
     * разрешений (свои файлы), файлы видны в «Файлах». Если запись почему-то
     * недоступна — личная папка приложения (видна только Mestia).
     */
    @Command
    fun storageRoot(invoke: Invoke) {
        val public = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Mestia")
        val dir = if (writable(public)) public
        else File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Mestia").apply { mkdirs() }
        invoke.resolve(JSObject().put("path", dir.absolutePath))
    }

    private fun writable(dir: File): Boolean = runCatching {
        dir.mkdirs()
        val probe = File(dir, ".mestia-probe")
        probe.writeText("")
        probe.delete()
    }.getOrDefault(false)

    /** Кадр из видео (3-я секунда, иначе первый) → jpg шириной до 480px. */
    @Command
    fun thumbnail(invoke: Invoke) {
        val a = invoke.parseArgs(ThumbArgs::class.java)
        pool.execute {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(a.videoPath)
                val frame = r.getFrameAtTime(3_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    ?: r.getFrameAtTime(0)
                    ?: throw IllegalStateException("нет кадра")
                val w = minOf(480, frame.width)
                val h = (frame.height.toLong() * w / frame.width).toInt().coerceAtLeast(1)
                val scaled = if (w == frame.width) frame else Bitmap.createScaledBitmap(frame, w, h, true)
                File(a.outPath).parentFile?.mkdirs()
                FileOutputStream(a.outPath).use { scaled.compress(Bitmap.CompressFormat.JPEG, 82, it) }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: e.toString())
            } finally {
                runCatching { r.release() }
            }
        }
    }

    /** Открыть файл во внешнем приложении (запасной плеер с системными кодеками). */
    @Command
    fun openPath(invoke: Invoke) {
        val a = invoke.parseArgs(PathArgs::class.java)
        try {
            val file = File(a.path)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val mime = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
            val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(Intent.createChooser(view, null))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /** Сообщить MediaStore о новом файле — появится в галерее и музыкальных плеерах. */
    @Command
    fun scanFile(invoke: Invoke) {
        val a = invoke.parseArgs(PathArgs::class.java)
        MediaScannerConnection.scanFile(activity.applicationContext, arrayOf(a.path), null, null)
        invoke.resolve()
    }

    /** «Назад» на первой вкладке: свернуть, как «Домой» (загрузки продолжаются). */
    @Command
    fun moveToBack(invoke: Invoke) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        invoke.resolve()
    }

    /** Забрать ссылку из «Поделиться» (один раз). */
    @Command
    fun takeShared(invoke: Invoke) {
        val text = sharedText
        sharedText = null
        invoke.resolve(JSObject().apply { if (text != null) put("text", text) })
    }
}
