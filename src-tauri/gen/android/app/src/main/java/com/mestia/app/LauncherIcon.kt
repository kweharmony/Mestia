package com.mestia.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Иконка лаунчера под тему: в манифесте на каждую тему свой activity-alias
 * `.Launcher<Тема>`, включён ровно один. Тема запоминается сразу (MestiaPlugin),
 * а переключается, когда приложение уходит с экрана (MainActivity.onStop): лаунчер
 * перестраивает ярлык, и делать это под пальцами пользователя не стоит.
 */
object LauncherIcon {
    /** Темы с иконкой; первая — alias, включённый в манифесте по умолчанию. */
    private val THEMES = listOf("mono", "lavender", "midnight", "matcha", "ember", "indigo", "forest", "graphite")

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("mestia", Context.MODE_PRIVATE)

    fun save(ctx: Context, theme: String) {
        if (theme in THEMES) prefs(ctx).edit().putString("launcherIcon", theme).apply()
    }

    fun apply(ctx: Context) {
        val theme = prefs(ctx).getString("launcherIcon", null) ?: return
        val pm = ctx.packageManager
        val pkg = ctx.packageName
        // Сначала включаем нужный, потом гасим остальные — чтобы ярлык не пропадал совсем.
        // Уже стоящие как надо не трогаем: лаунчер не перерисовывает ярлык зря.
        runCatching {
            for (t in THEMES.sortedBy { it != theme }) {
                val c = ComponentName(pkg, "$pkg.Launcher${t.replaceFirstChar { it.uppercase() }}")
                val want = t == theme
                if (isOn(pm, c, t == THEMES[0]) == want) continue
                val state = if (want) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                pm.setComponentEnabledSetting(c, state, PackageManager.DONT_KILL_APP)
            }
        }
    }

    private fun isOn(pm: PackageManager, c: ComponentName, enabledByDefault: Boolean): Boolean =
        when (pm.getComponentEnabledSetting(c)) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> enabledByDefault
            else -> false
        }
}
