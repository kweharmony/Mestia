package com.mestia.app

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())

  // Пока играет плеер, а приложение не на экране (экран погас, свернули), держим WebView
  // «видимым»: иначе Chromium ставит видео на паузу (WryActivity зовёт webView.onPause(),
  // а после onStop окно помечается невидимым). Повторяем раз в секунду — пометка
  // о невидимости приходит асинхронно, когда система перерисует окно.
  private val keepVisible = object : Runnable {
    override fun run() {
      if (!PlaybackService.isPlaying()) return
      findWebView()?.let {
        it.onResume()
        it.dispatchWindowVisibilityChanged(View.VISIBLE)
      }
      handler.postDelayed(this, 1000)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // С targetSdk 35+ окно всегда рисуется под статус-баром и жестовой панелью, а
    // env(safe-area-inset-*) в WebView ненадёжен — отступаем содержимое нативно.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onPause() {
    super.onPause()
    if (PlaybackService.isPlaying()) findWebView()?.onResume()
  }

  override fun onStop() {
    super.onStop()
    LauncherIcon.apply(this)
    handler.removeCallbacks(keepVisible)
    handler.post(keepVisible)
  }

  override fun onStart() {
    super.onStart()
    handler.removeCallbacks(keepVisible)
  }

  private fun findWebView(): WebView? = findWebView(window.decorView)

  private fun findWebView(v: View): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    }
    return null
  }
}
