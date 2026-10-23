//! Движок yt-dlp. На компьютере — sidecar-бинарник (tauri-plugin-shell), на Android —
//! Kotlin-плагин `MestiaPlugin` поверх youtubedl-android (встроенные Python, yt-dlp,
//! ffmpeg). Аргументы yt-dlp собирает общий код (downloader.rs); движок только
//! запускает процесс, построчно отдаёт вывод и умеет его отменить.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Откуда пришла строка вывода.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

/// Чем закончился запуск.
pub enum RunEnd {
    /// Процесс завершился с кодом (None — убит/отменён).
    Exited(Option<i32>),
    /// Задачу отменили до старта процесса (пока шёл резолв ссылки).
    CancelledBeforeStart,
}

/// Хэндл запущенного процесса: на компьютере — сам дочерний процесс, на Android
/// процессом владеет Kotlin-плагин, отменяем по id.
#[cfg(desktop)]
type Handle = tauri_plugin_shell::process::CommandChild;
#[cfg(mobile)]
type Handle = ();

#[derive(Default)]
struct Procs {
    running: HashMap<String, Handle>,
    /// Отменены до запуска процесса — не стартуем их вовсе.
    cancelled: HashSet<String>,
}

/// Активные процессы yt-dlp (id задачи → процесс) — для отмены.
#[derive(Default)]
pub struct ActiveProcs(Mutex<Procs>);

/// Проверка отмены и регистрация — под одним замком, чтобы отмена, пришедшая
/// во время резолва ссылки, не потерялась между ними. `start` создаёт процесс.
fn register(
    app: &AppHandle,
    id: &str,
    start: impl FnOnce() -> Result<Handle, String>,
) -> Result<bool, String> {
    let state = app.state::<ActiveProcs>();
    let mut procs = state.0.lock().map_err(|e| e.to_string())?;
    if procs.cancelled.remove(id) {
        return Ok(false);
    }
    let h = start()?;
    procs.running.insert(id.to_string(), h);
    Ok(true)
}

/// Процесс завершился сам — убираем из реестра активных.
fn forget(app: &AppHandle, id: &str) {
    if let Ok(mut procs) = app.state::<ActiveProcs>().0.lock() {
        procs.running.remove(id);
    }
}

/// Отдаёт строку без хвостовых `\r\n`; пустые пропускает.
fn emit_line(line: &str, f: &mut impl FnMut(&str)) {
    let l = line.trim_end_matches(['\r', '\n']);
    if !l.is_empty() {
        f(l);
    }
}

/// Запускает yt-dlp с аргументами `args` и построчно отдаёт вывод в `on_line`.
/// `keep_alive` — длительная загрузка: на Android держим foreground-сервис, чтобы
/// система не убила процесс в фоне.
#[cfg(desktop)]
pub async fn run(
    app: &AppHandle,
    id: &str,
    args: Vec<String>,
    _keep_alive: bool,
    mut on_line: impl FnMut(Stream, &str),
) -> Result<RunEnd, String> {
    use tauri_plugin_shell::{process::CommandEvent, ShellExt};

    let mut rx = None;
    let started = register(app, id, || {
        let (r, child) = app
            .shell()
            .command(crate::downloader::ytdlp_path(app))
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .args(args)
            .spawn()
            .map_err(|e| e.to_string())?;
        rx = Some(r);
        Ok(child)
    })?;
    let Some(mut rx) = rx.filter(|_| started) else {
        return Ok(RunEnd::CancelledBeforeStart);
    };

    // Вывод приходит кусками; строки собираем по '\n' отдельно для stdout и stderr.
    let (mut out, mut err) = (String::new(), String::new());
    let mut code = None;
    while let Some(ev) = rx.recv().await {
        let (buf, stream) = match ev {
            CommandEvent::Stdout(b) => {
                out.push_str(&String::from_utf8_lossy(&b));
                (&mut out, Stream::Out)
            }
            CommandEvent::Stderr(b) => {
                err.push_str(&String::from_utf8_lossy(&b));
                (&mut err, Stream::Err)
            }
            CommandEvent::Error(e) => {
                on_line(Stream::Err, &format!("ERROR: {e}"));
                continue;
            }
            CommandEvent::Terminated(p) => {
                code = p.code;
                continue;
            }
            _ => continue,
        };
        while let Some(i) = buf.find('\n') {
            let line: String = buf.drain(..=i).collect();
            emit_line(&line, &mut |l| on_line(stream, l));
        }
    }
    emit_line(&out, &mut |l| on_line(Stream::Out, l));
    emit_line(&err, &mut |l| on_line(Stream::Err, l));
    forget(app, id);
    Ok(RunEnd::Exited(code))
}

/// Android: процесс запускает Kotlin-плагин, строки stdout идут через IPC-канал
/// по мере появления, stderr — целиком по завершении (так устроен youtubedl-android).
#[cfg(mobile)]
pub async fn run(
    app: &AppHandle,
    id: &str,
    args: Vec<String>,
    keep_alive: bool,
    mut on_line: impl FnMut(Stream, &str),
) -> Result<RunEnd, String> {
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ExecArgs {
        id: String,
        args: Vec<String>,
        keep_alive: bool,
        channel: Channel,
    }
    #[derive(serde::Deserialize)]
    struct LineMsg {
        line: String,
    }
    #[derive(serde::Deserialize)]
    struct ExecResult {
        #[serde(default)]
        code: Option<i32>,
        #[serde(default)]
        stderr: String,
    }

    if !register(app, id, || Ok(()))? {
        return Ok(RunEnd::CancelledBeforeStart);
    }

    // Строки и итог — в одну очередь: Kotlin шлёт все строки до ответа, так что
    // порядок сохраняется и после Done читать больше нечего.
    enum Msg {
        Line(String),
        Done(Result<ExecResult, String>),
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Msg>();
    let tx_lines = tx.clone();
    let channel = Channel::<InvokeResponseBody>::new(move |body| {
        if let Ok(m) = body.deserialize::<LineMsg>() {
            let _ = tx_lines.send(Msg::Line(m.line));
        }
        Ok(())
    });
    let (app2, payload) = (app.clone(), ExecArgs { id: id.to_string(), args, keep_alive, channel });
    tauri::async_runtime::spawn(async move {
        let r = crate::mobile::plugin(&app2)
            .run_mobile_plugin_async::<ExecResult>("execute", payload)
            .await
            .map_err(|e| e.to_string());
        let _ = tx.send(Msg::Done(r));
    });
    let res = loop {
        match rx.recv().await {
            Some(Msg::Line(line)) => emit_line(&line, &mut |l| on_line(Stream::Out, l)),
            Some(Msg::Done(r)) => break r,
            None => break Err("Движок yt-dlp не ответил".into()),
        }
    };
    forget(app, id);

    let res = res?;
    for line in res.stderr.lines() {
        emit_line(line, &mut |l| on_line(Stream::Err, l));
    }
    Ok(RunEnd::Exited(res.code))
}

/// Отменяет задачу: убивает процесс, а если он ещё не запущен — помечает, чтобы
/// он не стартовал. Частичные .part-файлы остаются для дозакачки.
pub fn cancel(app: &AppHandle, id: &str) -> Result<(), String> {
    let handle = {
        let state = app.state::<ActiveProcs>();
        let mut procs = state.0.lock().map_err(|e| e.to_string())?;
        let h = procs.running.remove(id);
        if h.is_none() {
            procs.cancelled.insert(id.to_string());
        }
        h
    };
    #[cfg(desktop)]
    if let Some(child) = handle {
        child.kill().map_err(|e| e.to_string())?;
    }
    #[cfg(mobile)]
    if handle.is_some() {
        crate::mobile::cancel(app, id)?;
    }
    Ok(())
}

/// Итог короткого запуска: успех по коду выхода и собранный вывод.
pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Короткий запуск (метаданные) с жёстким таймаутом: по истечении процесс
/// убивается (иначе осиротевший yt-dlp продолжал бы работать в фоне).
pub async fn output(app: &AppHandle, args: Vec<String>, secs: u64) -> Result<RunOutput, String> {
    static N: AtomicU64 = AtomicU64::new(0);
    let id = format!("meta-{}", N.fetch_add(1, Ordering::Relaxed));
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(secs),
        run(app, &id, args, false, |s, l| {
            let buf = if s == Stream::Out { &mut stdout } else { &mut stderr };
            buf.push_str(l);
            buf.push('\n');
        }),
    )
    .await;
    match res {
        Ok(Ok(RunEnd::Exited(code))) => Ok(RunOutput { success: code == Some(0), stdout, stderr }),
        Ok(Ok(RunEnd::CancelledBeforeStart)) => Err("Запрос отменён".into()),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = cancel(app, &id);
            Err("Превышено время ожидания ответа от сервиса".into())
        }
    }
}
