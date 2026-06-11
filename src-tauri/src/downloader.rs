use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Активные дочерние процессы yt-dlp (id задачи → процесс) — для отмены.
#[derive(Default)]
pub struct ActiveProcs(pub Mutex<HashMap<String, CommandChild>>);

// Маркеры в выводе yt-dlp, по которым отличаем строки прогресса и итоговых файлов.
const MARK_PROGRESS: &str = "[[MP]]";
const MARK_FILE: &str = "[[MF]]";

// ── Структуры обмена с фронтендом ──────────────────────────────────────────────

/// Результат получения метаданных: одиночное видео или плейлист.
#[derive(Serialize)]
pub struct FetchResult {
    is_playlist: bool,
    title: String,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    platform: Option<String>,
    webpage_url: Option<String>,
    playlist_count: Option<u64>,
}

#[derive(Deserialize)]
pub struct DownloadArgs {
    id: String,
    url: String,
    format: String,
    #[serde(rename = "isAudio")]
    is_audio: bool,
    #[serde(rename = "audioFormat")]
    audio_format: Option<String>,
    /// "single" | "all" | "range"
    mode: String,
    /// для "range": номера/диапазон, напр. "1-5,8"
    items: Option<String>,
    /// каталог назначения (для плейлиста — его папка); иначе корень хранилища
    #[serde(rename = "outDir")]
    out_dir: Option<String>,
    /// восстановление: "resume" (дозакачать) | "restart" (заново) | null
    #[serde(default)]
    recovery: Option<String>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    id: String,
    downloaded: Option<f64>,
    total: Option<f64>,
    speed: Option<f64>,
    eta: Option<f64>,
    percent: f64,
    /// номер текущего видео в плейлисте и общее количество (для "X из N")
    index: Option<f64>,
    total_items: Option<f64>,
}

/// Одно завершённое (и перемещённое) видео — фронтенд добавляет его в БД.
#[derive(Serialize, Clone)]
struct ItemPayload {
    id: String,
    title: String,
    #[serde(rename = "filePath")]
    file_path: String,
    url: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    platform: Option<String>,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    id: String,
    count: u32,
    ok: bool,
    error: Option<String>,
}

// ── Команда: метаданные (видео или плейлист) ───────────────────────────────────

#[tauri::command]
pub async fn fetch_metadata(app: AppHandle, url: String) -> Result<FetchResult, String> {
    let output = app
        .shell()
        .command(binary_path("yt-dlp"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // --flat-playlist: не выкачиваем метаданные каждого видео плейлиста (быстро).
        .args(["--dump-single-json", "--flat-playlist", "--no-warnings", &url])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(first_meaningful_line(&String::from_utf8_lossy(&output.stderr)));
    }

    let v: Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).map_err(|e| e.to_string())?;

    let is_playlist =
        v.get("_type").and_then(Value::as_str) == Some("playlist") || v.get("entries").is_some();

    let platform = v.get("extractor_key").and_then(Value::as_str).map(String::from);
    let webpage_url = v.get("webpage_url").and_then(Value::as_str).map(String::from);

    if is_playlist {
        let count = v
            .get("playlist_count")
            .and_then(Value::as_u64)
            .or_else(|| v.get("entries").and_then(Value::as_array).map(|a| a.len() as u64));
        Ok(FetchResult {
            is_playlist: true,
            title: v.get("title").and_then(Value::as_str).unwrap_or("Плейлист").to_string(),
            uploader: v.get("uploader").and_then(Value::as_str).map(String::from),
            duration: None,
            thumbnail: None,
            platform,
            webpage_url,
            playlist_count: count,
        })
    } else {
        Ok(FetchResult {
            is_playlist: false,
            title: v.get("title").and_then(Value::as_str).unwrap_or("Без названия").to_string(),
            uploader: v.get("uploader").and_then(Value::as_str).map(String::from),
            duration: v.get("duration").and_then(Value::as_f64),
            thumbnail: v.get("thumbnail").and_then(Value::as_str).map(String::from),
            platform,
            webpage_url,
            playlist_count: None,
        })
    }
}

// ── Команда: скачивание (видео или плейлист) с потоковым прогрессом ────────────

#[tauri::command]
pub async fn start_download(app: AppHandle, args: DownloadArgs) -> Result<(), String> {
    let base_dir = match &args.out_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => crate::storage::storage_root(&app)?,
    };

    let is_batch = args.mode == "all" || args.mode == "range";

    // В плейлисте — порядковый номер в имени файла для удобной сортировки.
    let name_tmpl = if is_batch {
        "%(playlist_index)02d - %(title)s.%(ext)s"
    } else {
        "%(title)s.%(ext)s"
    };
    let out_tmpl = base_dir.join(name_tmpl).to_string_lossy().to_string();

    let mut yt_args: Vec<String> = vec![
        args.url.clone(),
        "--newline".into(),
        "--progress".into(),
        "--no-color".into(),
        "--no-warnings".into(),
        "--progress-template".into(),
        format!(
            "{MARK_PROGRESS}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.n_entries)s"
        ),
        "--print".into(),
        // JSON-объект по каждому перемещённому файлу (не-ASCII → \uXXXX).
        format!("after_move:{MARK_FILE}%(.{{title,filepath,webpage_url,duration,thumbnail,extractor_key}})j"),
        "-o".into(),
        out_tmpl,
        "--merge-output-format".into(),
        "mp4".into(),
        "-f".into(),
        args.format.clone(),
    ];

    // Режим плейлиста.
    match args.mode.as_str() {
        "single" => yt_args.push("--no-playlist".into()),
        "range" => {
            yt_args.push("--yes-playlist".into());
            if let Some(items) = &args.items {
                yt_args.push("--playlist-items".into());
                yt_args.push(items.clone());
            }
        }
        _ => yt_args.push("--yes-playlist".into()), // "all"
    }
    if is_batch {
        // Одно сбойное видео не должно прерывать всю пачку.
        yt_args.push("--ignore-errors".into());
    }

    // Восстановление прерванной загрузки.
    match args.recovery.as_deref() {
        // Дозакачать: готовые файлы пропустить, частичные продолжить (--continue по умолчанию).
        Some("resume") => yt_args.push("--no-overwrites".into()),
        // Заново: игнорировать частичные .part и перезаписать.
        Some("restart") => {
            yt_args.push("--no-continue".into());
            yt_args.push("--force-overwrites".into());
        }
        _ => {}
    }

    if let Some(dir) = ffmpeg_dir(&app) {
        yt_args.push("--ffmpeg-location".into());
        yt_args.push(dir);
    }

    if args.is_audio {
        let (codec, quality) = match args.audio_format.as_deref() {
            Some("mp3_320") => ("mp3", "0"),
            Some("mp3_128") => ("mp3", "5"),
            Some("wav") => ("wav", "5"),
            Some("flac") => ("flac", "5"),
            _ => ("mp3", "5"),
        };
        yt_args.push("-x".into());
        yt_args.push("--audio-format".into());
        yt_args.push(codec.into());
        yt_args.push("--audio-quality".into());
        yt_args.push(quality.into());
    }

    let (mut rx, child) = app
        .shell()
        .command(binary_path("yt-dlp"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .args(yt_args)
        .spawn()
        .map_err(|e| e.to_string())?;

    // Регистрируем процесс, чтобы его можно было отменить.
    if let Ok(mut procs) = app.state::<ActiveProcs>().0.lock() {
        procs.insert(args.id.clone(), child);
    }

    let id = args.id.clone();
    let mut out_buf = String::new();
    let mut err_buf = String::new();
    let mut count: u32 = 0;
    let mut last_err = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                out_buf.push_str(&String::from_utf8_lossy(&bytes));
                drain_lines(&mut out_buf, &id, &app, &mut count, &mut last_err);
            }
            CommandEvent::Stderr(bytes) => {
                err_buf.push_str(&String::from_utf8_lossy(&bytes));
                drain_lines(&mut err_buf, &id, &app, &mut count, &mut last_err);
            }
            CommandEvent::Error(e) => {
                last_err = e;
            }
            CommandEvent::Terminated(_) => {
                // Процесс завершён — убираем из реестра активных.
                if let Ok(mut procs) = app.state::<ActiveProcs>().0.lock() {
                    procs.remove(&id);
                }
                let ok = count > 0;
                let _ = app.emit(
                    "download://done",
                    DonePayload {
                        id: id.clone(),
                        count,
                        ok,
                        error: if ok {
                            None
                        } else if last_err.is_empty() {
                            Some("Загрузка не завершилась успешно".to_string())
                        } else {
                            Some(last_err.clone())
                        },
                    },
                );
            }
            _ => {}
        }
    }

    Ok(())
}

/// Отменяет активную загрузку — убивает процесс yt-dlp.
/// Частичные .part-файлы остаются, так что загрузку можно продолжить.
#[tauri::command]
pub fn cancel_download(app: AppHandle, id: String) -> Result<(), String> {
    let child = app
        .state::<ActiveProcs>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(c) = child {
        c.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Самообновление yt-dlp (официальный бинарник поддерживает -U).
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .command(binary_path("yt-dlp"))
        .args(["-U"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("Готово")
        .to_string();
    if output.status.success() {
        Ok(last)
    } else {
        Err(first_meaningful_line(&String::from_utf8_lossy(&output.stderr)))
    }
}

// ── Вспомогательные функции ─────────────────────────────────────────────────────

/// Разбирает буфер на полные строки (по '\n') и обрабатывает каждую.
fn drain_lines(buf: &mut String, id: &str, app: &AppHandle, count: &mut u32, last_err: &mut String) {
    while let Some(idx) = buf.find('\n') {
        let line: String = buf.drain(..=idx).collect();
        handle_line(line.trim_end(), id, app, count, last_err);
    }
}

/// Обрабатывает одну строку: прогресс / готовый файл (JSON) / ошибка.
fn handle_line(line: &str, id: &str, app: &AppHandle, count: &mut u32, last_err: &mut String) {
    if let Some(rest) = line.strip_prefix(MARK_PROGRESS) {
        if let Some(p) = parse_progress(id, rest) {
            let _ = app.emit("download://progress", p);
        }
    } else if let Some(rest) = line.strip_prefix(MARK_FILE) {
        if let Some(item) = parse_item(id, rest) {
            *count += 1;
            let _ = app.emit("download://item", item);
        }
    } else if line.contains("ERROR") {
        *last_err = line.trim().to_string();
    }
}

/// Парсит JSON-объект готового видео.
fn parse_item(id: &str, rest: &str) -> Option<ItemPayload> {
    let v: Value = serde_json::from_str(rest.trim()).ok()?;
    let file_path = v.get("filepath").and_then(Value::as_str)?.to_string();
    Some(ItemPayload {
        id: id.to_string(),
        title: v.get("title").and_then(Value::as_str).unwrap_or("Без названия").to_string(),
        file_path,
        url: v.get("webpage_url").and_then(Value::as_str).map(String::from),
        duration: v.get("duration").and_then(Value::as_f64),
        thumbnail: v.get("thumbnail").and_then(Value::as_str).map(String::from),
        platform: v.get("extractor_key").and_then(Value::as_str).map(String::from),
    })
}

/// Парсит строку прогресса "downloaded|total|total_est|speed|eta|index|n_entries".
fn parse_progress(id: &str, rest: &str) -> Option<ProgressPayload> {
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() < 5 {
        return None;
    }
    let num = |s: &str| -> Option<f64> {
        let s = s.trim();
        if s.is_empty() || s == "NA" || s == "None" {
            None
        } else {
            s.parse::<f64>().ok()
        }
    };

    let downloaded = num(parts[0]);
    let total = num(parts[1]).or_else(|| num(parts[2]));
    let speed = num(parts[3]);
    let eta = num(parts[4]);
    let index = parts.get(5).and_then(|s| num(s));
    let total_items = parts.get(6).and_then(|s| num(s));
    let percent = match (downloaded, total) {
        (Some(d), Some(t)) if t > 0.0 => (d / t * 100.0).min(100.0),
        _ => 0.0,
    };

    Some(ProgressPayload {
        id: id.to_string(),
        downloaded,
        total,
        speed,
        eta,
        percent,
        index,
        total_items,
    })
}

/// Абсолютный путь к бинарнику (yt-dlp/ffmpeg), который CLI кладёт рядом с exe.
pub(crate) fn binary_path(name: &str) -> PathBuf {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let direct = dir.join(&file);
            if direct.exists() {
                return direct;
            }
            let nested = dir.join("binaries").join(&file);
            if nested.exists() {
                return nested;
            }
            return direct;
        }
    }
    PathBuf::from(file)
}

/// Ищет каталог с бинарником ffmpeg рядом с приложением / в ресурсах / в dev-папке.
fn ffmpeg_dir(app: &AppHandle) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res);
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    for dir in candidates {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("ffmpeg") {
                    return Some(dir.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// Первая содержательная строка из stderr yt-dlp (для понятной ошибки).
fn first_meaningful_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Не удалось получить данные по ссылке")
        .to_string()
}
