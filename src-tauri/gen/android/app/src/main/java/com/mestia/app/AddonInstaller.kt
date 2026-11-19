package com.mestia.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageInfo
import android.os.Build
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

@InvokeArg
class AddonArgs {
    lateinit var id: String
    var path: String? = null
}

/** Модули устанавливает Android. Версию и сертификат сверяет PackageInstaller. */
internal object AddonInstaller {
    private val pending = ConcurrentHashMap<Int, Invoke>()
    private val ids = listOf("tags", "nearby")

    private fun split(id: String): String {
        require(id in ids) { "Неизвестное дополнение" }
        return "mestia_$id"
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(context: Context): PackageInfo =
        context.packageManager.getPackageInfo(context.packageName, 0)

    private fun apk(info: PackageInfo, id: String): File? {
        val index = info.splitNames.orEmpty().indexOf(split(id))
        return info.applicationInfo?.splitSourceDirs?.getOrNull(index)?.let(::File)
    }

    fun worker(context: Context, id: String): File? {
        val info = packageInfo(context)
        if (apk(info, id) == null) return null
        return worker(info, id)
    }

    private fun worker(info: PackageInfo, id: String): File? {
        val native = info.applicationInfo?.nativeLibraryDir ?: return null
        return File(native, "libmestia_addon_$id.so")
            .takeIf { it.isFile && it.canExecute() }
    }

    fun packages(context: Context) = JSObject().apply {
        val info = packageInfo(context)
        for (id in ids) {
            val file = apk(info, id)
            put(id, JSObject().put("installed", file != null && worker(info, id) != null)
                .put("present", file != null).put("bytes", file?.length() ?: 0L))
        }
    }

    fun change(context: Context, args: AddonArgs, invoke: Invoke) {
        val splitName = split(args.id)
        val source = args.path?.let { path ->
            File(path).canonicalFile.also {
                require(it.parentFile == context.cacheDir.canonicalFile && it.isFile) { "APK дополнения не найден" }
            }
        }
        if (source == null && apk(packageInfo(context), args.id) == null) {
            invoke.resolve()
            return
        }
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_INHERIT_EXISTING)
        params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                if (source == null) {
                    session.removeSplit(splitName)
                } else {
                    session.openWrite("$splitName.apk", 0, source.length()).use { output ->
                        source.inputStream().use { it.copyTo(output) }
                        session.fsync(output)
                    }
                    // APK больше не нужен в кэше, даже если установка перезапустит Mestia.
                    source.delete()
                }
                val callback = PendingIntent.getBroadcast(context, id,
                    Intent(context, AddonInstallReceiver::class.java).putExtra("mestia.session", id),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                pending[id] = invoke
                session.commit(callback.intentSender)
            }
        } catch (error: Exception) {
            pending.remove(id)
            runCatching { installer.abandonSession(id) }
            throw error
        }
    }

    fun result(context: Context, intent: Intent) {
        val id = intent.getIntExtra("mestia.session", -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            try {
                requireNotNull(confirmation)
                context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
                runCatching { context.packageManager.packageInstaller.abandonSession(id) }
                pending.remove(id)?.reject("Не удалось открыть установщик Android")
            }
            return
        }
        val invoke = pending.remove(id) ?: return
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> invoke.resolve()
            PackageInstaller.STATUS_FAILURE_ABORTED -> invoke.reject("Установка модуля отменена")
            else -> invoke.reject(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                ?: "Android не установил модуль")
        }
    }
}

class AddonInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AddonInstaller.result(context, intent)
}
