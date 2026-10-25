package com.mestia.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.ActivityCallback
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
class FullscreenArgs {
    var on: Boolean = false
    var landscape: Boolean = true
}

@InvokeArg
class OnArgs {
    var on: Boolean = false
}

@InvokeArg
class MediaArgs {
    var active: Boolean = false
    var title: String = ""
    var artist: String? = null
    var artwork: String? = null
    var path: String? = null
    var duration: Double = 0.0
    var position: Double = 0.0
    var playing: Boolean = false
    var rate: Double = 1.0
    var hasPrev: Boolean = false
    var hasNext: Boolean = false
}

@InvokeArg
class ChannelArgs {
    lateinit var channel: Channel
}

@InvokeArg
class AwakeArgs {
    lateinit var id: String
    var on: Boolean = false
}

@InvokeArg
class ProgressArgs {
    lateinit var id: String
    var title: String? = null
    var percent: Double = 0.0
}

@InvokeArg
class ThemeArgs {
    lateinit var theme: String
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

    // Папка, выбранная в pickFolder, пока пользователь выдаёт «Доступ ко всем файлам».
    private var pendingFolder: String? = null

    // Держится, пока включена видимость в локальной сети (lan.rs).
    private var multicastLock: WifiManager.MulticastLock? = null

    // Разрешение на чтение медиа уже спрашивали в этом запуске (не надоедаем).
    private var mediaAsked = false

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
            if (a.keepAlive) {
                askNotifications()
                DownloadService.begin(activity, a.id)
            }
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
            } catch (e: Throwable) {
                // Throwable, а не Exception: сбой загрузки нативных библиотек/классов
                // движка должен дойти до UI ошибкой, а не уронить приложение.
                invoke.reject(e.message ?: e.toString())
            } finally {
                if (a.keepAlive) DownloadService.end(activity, a.id)
            }
        }
    }

    /**
     * Android 13+: без разрешения уведомление загрузки не видно в шторке. Спрашиваем
     * один раз — при первой загрузке, когда понятно, зачем оно.
     */
    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("mestia", Context.MODE_PRIVATE)
        if (prefs.getBoolean("notifAsked", false)) return
        prefs.edit().putBoolean("notifAsked", true).apply()
        activity.runOnUiThread {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
        }
    }

    /**
     * Передача файлов «Рядом»: держим службу загрузок (процессор и Wi-Fi не засыпают
     * с погасшим экраном). Rust зовёт on=true при «Отправить»/«Принять», off — в конце.
     */
    @Command
    fun keepAwake(invoke: Invoke) {
        val a = invoke.parseArgs(AwakeArgs::class.java)
        if (a.on) {
            askNotifications()
            DownloadService.begin(activity, a.id)
        } else {
            DownloadService.end(activity, a.id)
        }
        invoke.resolve()
    }

    /**
     * Доступ к чужим медиафайлам в папке загрузок. Без него Android (scoped storage)
     * прячет из листинга папки всё, что создано не Mestia, — медиатека выглядит пустой.
     * Спрашиваем раз за запуск; ответ пользователя приходит после возврата в приложение,
     * и медиатека пересканирует папку по focus. Итог: {granted}.
     */
    @Command
    fun ensureMediaAccess(invoke: Invoke) {
        val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            arrayOf(Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_AUDIO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        val granted = Environment.isExternalStorageManager() ||
            perms.all { activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        if (!granted && !mediaAsked) {
            mediaAsked = true
            activity.runOnUiThread { activity.requestPermissions(perms, 7302) }
        }
        invoke.resolve(JSObject().put("granted", granted))
    }

    /** Процент загрузки в уведомлении (Rust шлёт не чаще раза в секунду). */
    @Command
    fun downloadProgress(invoke: Invoke) {
        val a = invoke.parseArgs(ProgressArgs::class.java)
        DownloadService.progress(a.id, a.title?.takeIf { it.isNotBlank() }, a.percent.toInt())
        invoke.resolve()
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
            } catch (e: Throwable) {
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

    /**
     * Выбор папки загрузок. yt-dlp пишет по обычным путям, а не через content://, поэтому
     * дерево SAF переводим в путь на диске. Вне Download/ без «Доступа ко всем файлам»
     * писать нельзя — тогда отправляем в системные настройки за этим разрешением.
     * Итог: {path} или {} при отмене.
     */
    @Command
    fun pickFolder(invoke: Invoke) {
        startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "onFolderPicked")
    }

    @ActivityCallback
    private fun onFolderPicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject())
            return
        }
        val path = treeToPath(uri)
        if (path == null) {
            invoke.reject("Эту папку нельзя выбрать — выберите папку во внутренней памяти или на SD-карте")
            return
        }
        when {
            writable(File(path)) -> invoke.resolve(JSObject().put("path", path))
            !Environment.isExternalStorageManager() -> {
                pendingFolder = path
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:${activity.packageName}"),
                )
                startActivityForResult(invoke, intent, "onAllFilesAccess")
            }
            else -> invoke.reject("Permission denied: $path")
        }
    }

    @ActivityCallback
    private fun onAllFilesAccess(invoke: Invoke, result: ActivityResult) {
        // Код возврата у экрана настроек не говорит о разрешении — проверяем запись заново.
        val path = pendingFolder
        pendingFolder = null
        if (path != null && writable(File(path))) invoke.resolve(JSObject().put("path", path))
        else invoke.reject("Permission denied: нет «Доступа ко всем файлам»")
    }

    /** content://…/tree/primary:Movies/X → /storage/emulated/0/Movies/X (и SD-карты). */
    private fun treeToPath(uri: Uri): String? {
        val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        if (id.startsWith("raw:")) return id.removePrefix("raw:")
        val vol = id.substringBefore(':')
        val rel = id.substringAfter(':', "")
        val base = when (vol) {
            "primary" -> Environment.getExternalStorageDirectory().absolutePath
            "home" -> File(Environment.getExternalStorageDirectory(), Environment.DIRECTORY_DOCUMENTS).absolutePath
            "", "downloads" -> return null
            else -> "/storage/$vol"
        }
        return if (rel.isEmpty()) base else "$base/$rel"
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

    /**
     * Полноэкранный плеер: HTML-fullscreen в WebView Tauri не работает, поэтому плеер
     * растягивается сам, а здесь — скрыть системные панели (вернуть — свайпом от края),
     * повернуть экран под ролик и не гасить его. off — всё обратно.
     */
    @Command
    fun setFullscreen(invoke: Invoke) {
        val a = invoke.parseArgs(FullscreenArgs::class.java)
        activity.runOnUiThread {
            val window = activity.window
            val bars = WindowCompat.getInsetsController(window, window.decorView)
            if (a.on) {
                bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                bars.hide(WindowInsetsCompat.Type.systemBars())
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                activity.requestedOrientation =
                    if (a.landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    else ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            } else {
                bars.show(WindowInsetsCompat.Type.systemBars())
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }
        invoke.resolve()
    }

    /** «Назад» на первой вкладке: свернуть, как «Домой» (загрузки продолжаются). */
    @Command
    fun moveToBack(invoke: Invoke) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        invoke.resolve()
    }

    /** Локальная сеть: принимать multicast-анонсы (Wi-Fi по умолчанию их отбрасывает). */
    @Command
    fun lanMulticast(invoke: Invoke) {
        val a = invoke.parseArgs(OnArgs::class.java)
        val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (a.on) {
            if (multicastLock == null) {
                multicastLock = wifi.createMulticastLock("mestia-lan").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
        } else {
            multicastLock?.release()
            multicastLock = null
        }
        invoke.resolve()
    }

    /** Имя устройства для других в сети: из настроек «О телефоне», иначе модель. */
    @Command
    fun deviceName(invoke: Invoke) {
        val name = runCatching {
            Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}"
        invoke.resolve(JSObject().put("name", name))
    }

    /** Идёт воспроизведение: служба PlaybackService держит процессор и Wi-Fi при выключенном экране. */
    @Command
    fun playbackKeepAlive(invoke: Invoke) {
        val a = invoke.parseArgs(OnArgs::class.java)
        PlaybackService.set(activity.applicationContext, a.on)
        invoke.resolve()
    }

    /** Иконка лаунчера под тему (переключится в MainActivity.onStop, см. LauncherIcon). */
    @Command
    fun setLauncherIcon(invoke: Invoke) {
        val a = invoke.parseArgs(ThemeArgs::class.java)
        LauncherIcon.save(activity, a.theme)
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
