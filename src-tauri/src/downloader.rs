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
    /// Прикидка размеров по пресетам качества (только для одиночного видео).
    sizes: Option<FormatSizes>,
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
    /// Размер готового файла на диске, байты (для отображения в медиатеке).
    size: Option<f64>,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    id: String,
    count: u32,
    ok: bool,
    error: Option<String>,
}

/// Аргументы доступа к источнику (куки браузера) — общие для метаданных и загрузки.
/// Пусто, если в настройках браузер не выбран.
fn cookies_args(app: &AppHandle) -> Vec<String> {
    match crate::storage::setting(app, "cookiesBrowser") {
        Some(b) if !b.trim().is_empty() => vec!["--cookies-from-browser".into(), b],
        _ => Vec::new(),
    }
}

/// Сколько фрагментов качать параллельно (главный фактор скорости на DASH/HLS).
/// Настройка `concurrentFragments`, по умолчанию 5; ограничено 1..=16.
fn concurrent_fragments(app: &AppHandle) -> String {
    crate::storage::setting(app, "concurrentFragments")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(5)
        .clamp(1, 16)
        .to_string()
}

// ── Команда: метаданные (видео или плейлист) ───────────────────────────────────

#[tauri::command]
pub async fn fetch_metadata(app: AppHandle, url: String) -> Result<FetchResult, String> {
    // --flat-playlist: не выкачиваем метаданные каждого видео плейлиста (быстро).
    // --socket-timeout: не виснем бесконечно на недоступном хосте.
    let mut meta_args: Vec<String> = vec![
        "--dump-single-json".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(),
        "20".into(),
    ];
    meta_args.extend(cookies_args(&app)); // приватные/возрастные — по кукам браузера
    meta_args.push(url);

    let output = app
        .shell()
        .command(binary_path("yt-dlp"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .args(meta_args)
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
            sizes: None,
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
            // formats есть и при --flat-playlist для одиночного видео — считаем сразу.
            sizes: Some(compute_sizes(&v)),
        })
    }
}

// ── Оценка размера по форматам (для одиночного видео) ──────────────────────────

/// Прикидка итогового размера для пресетов качества (видео+аудио), байты.
#[derive(Serialize)]
pub struct FormatSizes {
    v1080: Option<f64>,
    v720: Option<f64>,
    v480: Option<f64>,
    vbest: Option<f64>,
}

fn is_video(f: &Value) -> bool {
    f.get("vcodec").and_then(Value::as_str).map_or(false, |c| c != "none")
}
fn is_audio(f: &Value) -> bool {
    f.get("acodec").and_then(Value::as_str).map_or(false, |c| c != "none")
}
fn fmt_size(f: &Value) -> Option<f64> {
    f.get("filesize")
        .and_then(Value::as_f64)
        .or_else(|| f.get("filesize_approx").and_then(Value::as_f64))
}

/// Размер лучшей аудиодорожки (audio-only) — добавляется к видео без звука.
fn best_audio_size(formats: &[Value]) -> Option<f64> {
    formats
        .iter()
        .filter(|f| is_audio(f) && !is_video(f))
        .filter_map(fmt_size)
        .fold(None, |acc, s| Some(acc.map_or(s, |a: f64| a.max(s))))
}

/// Итоговый размер видео при ограничении высоты `cap` (None — без ограничения):
/// берём поток с наибольшей высотой/размером в пределах cap и добавляем аудио,
/// если поток без звука.
fn video_total(formats: &[Value], cap: Option<u64>, audio: Option<f64>) -> Option<f64> {
    let mut best: Option<(u64, f64, bool)> = None; // (высота, размер, есть_звук)
    for f in formats {
        if !is_video(f) {
            continue;
        }
        let h = f.get("height").and_then(Value::as_u64).unwrap_or(0);
        if let Some(c) = cap {
            if h > c {
                continue;
            }
        }
        let Some(sz) = fmt_size(f) else { continue };
        let better = match best {
            None => true,
            Some((bh, bsz, _)) => h > bh || (h == bh && sz > bsz),
        };
        if better {
            best = Some((h, sz, is_audio(f)));
        }
    }
    best.map(|(_, sz, has_audio)| if has_audio { sz } else { sz + audio.unwrap_or(0.0) })
}

fn compute_sizes(v: &Value) -> FormatSizes {
    let formats = v.get("formats").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let audio = best_audio_size(formats);
    FormatSizes {
        v1080: video_total(formats, Some(1080), audio),
        v720: video_total(formats, Some(720), audio),
        v480: video_total(formats, Some(480), audio),
        vbest: video_total(formats, None, audio),
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
        // Большие/длинные видео не должны обрываться из-за единичного сбоя сети —
        // иначе на диск падает усечённый («повреждённый») файл.
        "--retries".into(),
        "infinite".into(),
        "--fragment-retries".into(),
        "infinite".into(),
        // Параллельная загрузка фрагментов DASH/HLS — главный фактор скорости.
        "--concurrent-fragments".into(),
        concurrent_fragments(&app),
        // Больший буфер чтения сети ускоряет запись крупных потоков.
        "--buffer-size".into(),
        "16M".into(),
        // Не упираться в файловые блокировки на медленных дисках/microSD.
        "--file-access-retries".into(),
        "10".into(),
        // Имена файлов, безопасные для Windows/FAT — медиатека часто живёт на microSD.
        "--windows-filenames".into(),
        // Слишком длинные имена бьются о лимит пути Windows (260) — подрезаем.
        "--trim-filenames".into(),
        "200".into(),
        // Метаданные (название/автор/дата) внутрь контейнера.
        "--embed-metadata".into(),
        "--progress-template".into(),
        format!(
            "{MARK_PROGRESS}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.n_entries)s"
        ),
        "--print".into(),
        // JSON-объект по каждому перемещённому файлу (не-ASCII → \uXXXX).
        format!("after_move:{MARK_FILE}%(.{{title,filepath,webpage_url,duration,thumbnail,extractor_key,filesize,filesize_approx}})j"),
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
        // Обложка как album art в файл (mp3/m4a/flac). Для wav контейнер её
        // не поддерживает — yt-dlp просто пропустит этот шаг.
        if codec != "wav" {
            yt_args.push("--embed-thumbnail".into());
        }
    }

    // Куки браузера — для приватных/возрастных/members-видео.
    yt_args.extend(cookies_args(&app));

    // Субтитры (только видео): скачиваем и встраиваем в контейнер.
    if !args.is_audio && crate::storage::setting(&app, "subtitles").as_deref() == Some("1") {
        let lang = crate::storage::setting(&app, "subtitlesLang")
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "ru,en".into());
        yt_args.push("--write-subs".into());
        yt_args.push("--write-auto-subs".into());
        yt_args.push("--sub-langs".into());
        yt_args.push(lang);
        yt_args.push("--embed-subs".into());
    }

    // SponsorBlock — вырезать спонсорские/интро сегменты.
    if crate::storage::setting(&app, "sponsorblock").as_deref() == Some("1") {
        yt_args.push("--sponsorblock-remove".into());
        yt_args.push("default".into());
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
        if let Some(mut item) = parse_item(id, rest) {
            // Реальный размер итогового файла (после merge/конвертации) — точнее,
            // чем filesize из метаданных yt-dlp, который для merged-видео часто пуст.
            if let Ok(meta) = std::fs::metadata(&item.file_path) {
                item.size = Some(meta.len() as f64);
            }
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
        // Из метаданных (как запасной вариант); реальный размер проставит handle_line.
        size: v
            .get("filesize")
            .and_then(Value::as_f64)
            .or_else(|| v.get("filesize_approx").and_then(Value::as_f64)),
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

/// Понятная ошибка из stderr yt-dlp: сначала ищем строку с «ERROR» (там суть),
/// иначе — первую непустую (трейсбэк/прочий вывод).
fn first_meaningful_line(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .find(|l| l.contains("ERROR"))
        .or_else(|| lines.first())
        .map(|l| l.to_string())
        .unwrap_or_else(|| "Не удалось получить данные по ссылке".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_basic() {
        // downloaded|total|total_est|speed|eta|index|n_entries
        let p = parse_progress("t1", "1000|2000|NA|500|10|2|5").unwrap();
        assert_eq!(p.downloaded, Some(1000.0));
        assert_eq!(p.total, Some(2000.0));
        assert_eq!(p.speed, Some(500.0));
        assert_eq!(p.eta, Some(10.0));
        assert_eq!(p.percent, 50.0);
        assert_eq!(p.index, Some(2.0));
        assert_eq!(p.total_items, Some(5.0));
    }

    #[test]
    fn progress_total_falls_back_to_estimate() {
        // total = NA → берём total_bytes_estimate (третье поле)
        let p = parse_progress("t1", "1000|NA|4000|0|0").unwrap();
        assert_eq!(p.total, Some(4000.0));
        assert_eq!(p.percent, 25.0);
    }

    #[test]
    fn progress_handles_na_and_none() {
        let p = parse_progress("t1", "NA|None|NA|None|NA").unwrap();
        assert_eq!(p.downloaded, None);
        assert_eq!(p.total, None);
        assert_eq!(p.percent, 0.0); // без total процент не считаем
    }

    #[test]
    fn progress_too_few_fields_is_none() {
        assert!(parse_progress("t1", "1|2|3").is_none());
    }

    #[test]
    fn item_parses_json() {
        let json = r#"{"title":"Видео","filepath":"/m/v.mp4","webpage_url":"https://x","duration":12.5,"thumbnail":"https://t","extractor_key":"YouTube","filesize":2048}"#;
        let item = parse_item("t1", json).unwrap();
        assert_eq!(item.title, "Видео");
        assert_eq!(item.file_path, "/m/v.mp4");
        assert_eq!(item.url.as_deref(), Some("https://x"));
        assert_eq!(item.duration, Some(12.5));
        assert_eq!(item.platform.as_deref(), Some("YouTube"));
        assert_eq!(item.size, Some(2048.0));
    }

    #[test]
    fn item_size_falls_back_to_approx_then_none() {
        let approx = parse_item("t1", r#"{"filepath":"/m/v.mp4","filesize_approx":999}"#).unwrap();
        assert_eq!(approx.size, Some(999.0));
        let none = parse_item("t1", r#"{"filepath":"/m/v.mp4"}"#).unwrap();
        assert_eq!(none.size, None);
    }

    #[test]
    fn item_without_filepath_is_none() {
        // filepath обязателен — без него считать файл готовым нельзя
        assert!(parse_item("t1", r#"{"title":"Без файла"}"#).is_none());
    }

    #[test]
    fn item_title_defaults_when_missing() {
        let item = parse_item("t1", r#"{"filepath":"/m/v.mp4"}"#).unwrap();
        assert_eq!(item.title, "Без названия");
    }

    #[test]
    fn meaningful_line_skips_blanks() {
        assert_eq!(first_meaningful_line("\n  \n  ERROR: boom\nnext"), "ERROR: boom");
        assert_eq!(first_meaningful_line("   "), "Не удалось получить данные по ссылке");
    }

    #[test]
    fn meaningful_line_prefers_error_over_earlier_noise() {
        let text = "WARNING: что-то\nTraceback ...\nERROR: видео недоступно\nfoo";
        assert_eq!(first_meaningful_line(text), "ERROR: видео недоступно");
    }

    #[test]
    fn meaningful_line_falls_back_to_first_when_no_error() {
        assert_eq!(first_meaningful_line("просто строка\nвторая"), "просто строка");
    }

    #[test]
    fn sizes_combine_video_and_audio_within_caps() {
        let json = serde_json::json!({
            "formats": [
                {"vcodec":"avc1","acodec":"none","height":480,"filesize":40},
                {"vcodec":"avc1","acodec":"none","height":1080,"filesize":100},
                {"vcodec":"vp9","acodec":"none","height":2160,"filesize":500},
                {"vcodec":"none","acodec":"mp4a","filesize":10},
                {"vcodec":"none","acodec":"opus","filesize":8}
            ]
        });
        let s = compute_sizes(&json);
        assert_eq!(s.v480, Some(50.0));   // 40 видео + 10 лучшее аудио
        assert_eq!(s.v1080, Some(110.0)); // 100 + 10
        assert_eq!(s.vbest, Some(510.0)); // 500 (2160p) + 10
    }

    #[test]
    fn sizes_progressive_stream_not_double_counted() {
        // Прогрессивный поток уже со звуком — аудио не прибавляем.
        let json = serde_json::json!({
            "formats": [
                {"vcodec":"avc1","acodec":"mp4a","height":360,"filesize":70},
                {"vcodec":"none","acodec":"mp4a","filesize":10}
            ]
        });
        let s = compute_sizes(&json);
        assert_eq!(s.v480, Some(70.0));
    }

    #[test]
    fn sizes_uses_filesize_approx_and_handles_empty() {
        let json = serde_json::json!({
            "formats": [
                {"vcodec":"avc1","acodec":"none","height":720,"filesize_approx":200}
            ]
        });
        // аудио нет — возвращаем только видео
        assert_eq!(compute_sizes(&json).v720, Some(200.0));
        // без formats — всё None
        assert_eq!(compute_sizes(&serde_json::json!({})).vbest, None);
    }
}
