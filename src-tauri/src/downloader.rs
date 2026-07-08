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
    /// Что реально передать в загрузку: для Spotify/Apple/поиска — точная ссылка
    /// найденного видео (чтобы не резолвить повторно), иначе None → качаем по исходной.
    resolved_url: Option<String>,
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

/// Прокси для yt-dlp — общий для метаданных и загрузки. Пусто, если не задан.
/// Значение пользователь вписывает сам (`http://…`, `socks5://…`); встроенных
/// прокси/обхода геоблока приложение не поставляет — это штатный `--proxy` yt-dlp.
fn proxy_args(app: &AppHandle) -> Vec<String> {
    match crate::storage::setting(app, "proxy") {
        Some(p) if !p.trim().is_empty() => vec!["--proxy".into(), p.trim().to_string()],
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

/// Тримминг мусорных параметров ссылки и снятие ловушки «видео с плейлистом»:
/// у YouTube watch-ссылок с `v=` убираем `list=/index=` — иначе `--flat-playlist`
/// разворачивает автомикс (RD…) и одиночное видео ошибочно считается плейлистом.
/// Не-http (поисковые запросы, `spotify:` и т.п.) возвращаем как есть.
pub fn normalize_url(input: &str) -> String {
    let s = input.trim();
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return s.to_string();
    }
    let (base, rest) = match s.split_once('?') {
        Some(x) => x,
        None => return s.to_string(),
    };
    let query = rest.split('#').next().unwrap_or(rest); // отбрасываем фрагмент
    let low_base = base.to_lowercase();
    let is_youtube = low_base.contains("youtube.com") || low_base.contains("youtu.be");

    // Трекинг-параметры, которые всегда лишние.
    const TRACK: &[&str] = &[
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "si", "feature", "gclid", "fbclid", "yclid", "spm", "_ga",
    ];
    // Параметры плейлиста YouTube — снимаем только если это ссылка на видео (есть v=).
    const YT_PLAYLIST: &[&str] = &["list", "index", "start_radio", "pp"];

    let pairs: Vec<(&str, &str)> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| p.split_once('=').unwrap_or((p, "")))
        .collect();
    let has_v = pairs.iter().any(|(k, _)| *k == "v");

    let kept: Vec<String> = pairs
        .into_iter()
        .filter(|(k, _)| {
            if TRACK.contains(k) {
                return false;
            }
            if is_youtube && has_v && YT_PLAYLIST.contains(k) {
                return false;
            }
            true
        })
        .map(|(k, v)| if v.is_empty() { k.to_string() } else { format!("{k}={v}") })
        .collect();

    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Запуск yt-dlp с жёстким таймаутом (чтобы не висеть вечно) и одним мягким
/// повтором на транзиентной ошибке запуска/сети. На таймаут — сразу ошибка.
async fn ytdlp_output_timeout(
    app: &AppHandle,
    args: &[String],
    secs: u64,
) -> Result<tauri_plugin_shell::process::Output, String> {
    use tokio::time::{sleep, timeout, Duration};
    let mut last = "Не удалось получить данные по ссылке".to_string();
    for attempt in 0..2u8 {
        let cmd = app
            .shell()
            .command(ytdlp_path(app))
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .args(args.to_vec());
        match timeout(Duration::from_secs(secs), cmd.output()).await {
            Ok(Ok(out)) => return Ok(out),
            Ok(Err(e)) => {
                last = e.to_string();
                if attempt == 0 {
                    sleep(Duration::from_millis(500)).await; // мягкий повтор
                    continue;
                }
                break;
            }
            Err(_) => return Err("Превышено время ожидания ответа от сервиса".into()),
        }
    }
    Err(last)
}

// ── Команда: метаданные (видео или плейлист) ───────────────────────────────────

#[tauri::command]
pub async fn fetch_metadata(app: AppHandle, url: String) -> Result<FetchResult, String> {
    // Spotify/Apple Music → поисковый запрос на YouTube; VK Music/Звук → MANUAL_QUERY.
    let url = resolve_input(&url).await?;
    // Поиск (ytsearch/scsearch) возвращает «плейлист» из результатов — берём первый
    // и показываем как одиночный трек; для него нужны полные метаданные (без flat).
    let is_search = url.starts_with("ytsearch") || url.starts_with("scsearch");

    // --flat-playlist: не выкачиваем метаданные каждого видео плейлиста (быстро).
    // --socket-timeout: не виснем бесконечно на недоступном хосте.
    let mut meta_args: Vec<String> = vec![
        "--dump-single-json".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(),
        "20".into(),
    ];
    if !is_search {
        meta_args.push("--flat-playlist".into());
    }
    meta_args.extend(cookies_args(&app)); // приватные/возрастные — по кукам браузера
    meta_args.extend(proxy_args(&app)); // пользовательский прокси (если задан)
    meta_args.push(url);

    // Жёсткий таймаут + мягкий повтор — чтобы не «крутилось вечно» и переживало
    // единичный сетевой сбой.
    let output = ytdlp_output_timeout(&app, &meta_args, 30).await?;

    if !output.status.success() {
        return Err(first_meaningful_line(&String::from_utf8_lossy(&output.stderr)));
    }

    let v: Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).map_err(|e| e.to_string())?;

    // Результат поиска — «плейлист» из совпадений; разворачиваем в первый трек.
    let v = if is_search {
        v.get("entries")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| "Ничего не найдено".to_string())?
    } else {
        v
    };

    let is_playlist = !is_search
        && (v.get("_type").and_then(Value::as_str) == Some("playlist") || v.get("entries").is_some());

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
            resolved_url: None, // плейлист качаем по исходной ссылке
        })
    } else {
        // Для поиска (Spotify/Apple/ручной ввод) закрепляем точную ссылку найденного
        // видео — тогда загрузка не резолвит заново и берёт ровно то, что показали.
        let resolved_url = if is_search { webpage_url.clone() } else { None };
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
            resolved_url,
        })
    }
}

// ── Оценка размера по форматам (для одиночного видео) ──────────────────────────

/// Прикидка итогового размера для пресетов качества (видео+аудио), байты.
#[derive(Serialize)]
pub struct FormatSizes {
    v2160: Option<f64>,
    v1440: Option<f64>,
    v1080: Option<f64>,
    v720: Option<f64>,
    v480: Option<f64>,
    vbest: Option<f64>,
    /// Максимальная высота видеодорожки в источнике — чтобы показывать 2K/4K только
    /// когда они реально есть.
    max_height: Option<u64>,
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
    let max_height = formats
        .iter()
        .filter(|f| is_video(f))
        .filter_map(|f| f.get("height").and_then(Value::as_u64))
        .max();
    FormatSizes {
        v2160: video_total(formats, Some(2160), audio),
        v1440: video_total(formats, Some(1440), audio),
        v1080: video_total(formats, Some(1080), audio),
        v720: video_total(formats, Some(720), audio),
        v480: video_total(formats, Some(480), audio),
        vbest: video_total(formats, None, audio),
        max_height,
    }
}

// ── Команда: скачивание (видео или плейлист) с потоковым прогрессом ────────────

#[tauri::command]
pub async fn start_download(app: AppHandle, args: DownloadArgs) -> Result<(), String> {
    let base_dir = match &args.out_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => crate::storage::storage_root(&app)?,
    };

    // Spotify/Apple Music → ytsearch1:..., прочее без изменений.
    let input = resolve_input(&args.url).await?;
    let is_search = input.starts_with("ytsearch") || input.starts_with("scsearch");

    let is_batch = args.mode == "all" || args.mode == "range";

    // В плейлисте — порядковый номер в имени файла для удобной сортировки (папка
    // плейлиста + индекс уже дают уникальность). Одиночные же качаются в общий
    // корень, где разные видео могут иметь одинаковый заголовок — добавляем id,
    // чтобы не затирать друг друга (в медиатеке всё равно показывается title из БД).
    let name_tmpl = if is_batch {
        "%(playlist_index)02d - %(title)s.%(ext)s"
    } else {
        "%(title)s [%(id)s].%(ext)s"
    };
    let out_tmpl = base_dir.join(name_tmpl).to_string_lossy().to_string();

    let mut yt_args: Vec<String> = vec![
        input.clone(),
        "--newline".into(),
        "--progress".into(),
        "--no-color".into(),
        "--no-warnings".into(),
        // Устойчивость к сетевым сбоям, но без бесконечного цикла: на жёсткой
        // ошибке (403/приватное) yt-dlp не должен молотить вечно, занимая слот.
        "--retries".into(),
        "10".into(),
        "--fragment-retries".into(),
        "10".into(),
        "--retry-sleep".into(),
        "exp=1:30".into(),
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
        // Для поиска --no-playlist не нужен: ytsearch1 уже отдаёт один результат,
        // а с поисковым «плейлистом» этот флаг сбивает yt-dlp.
        "single" if is_search => {}
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
        yt_args.push("-x".into());
        // "best"/None при «Оригинал» — извлекаем дорожку как есть, без перекодирования.
        // Обложку встраиваем во все контейнеры, кроме wav (он album art не поддерживает).
        let embed_thumb = match args.audio_format.as_deref() {
            Some("best") => true, // оригинальный контейнер, --audio-format не задаём
            other => {
                let (codec, quality) = match other {
                    Some("mp3_320") => ("mp3", "0"),
                    Some("mp3_128") => ("mp3", "5"),
                    Some("m4a") => ("m4a", "0"),
                    Some("opus") => ("opus", "5"),
                    Some("ogg") => ("vorbis", "5"),
                    Some("flac") => ("flac", "5"),
                    Some("wav") => ("wav", "5"),
                    _ => ("mp3", "5"),
                };
                yt_args.push("--audio-format".into());
                yt_args.push(codec.into());
                yt_args.push("--audio-quality".into());
                yt_args.push(quality.into());
                codec != "wav"
            }
        };
        if embed_thumb {
            yt_args.push("--embed-thumbnail".into());
        }
    }

    // Куки браузера — для приватных/возрастных/members-видео.
    yt_args.extend(cookies_args(&app));
    // Пользовательский прокси (если задан) — для геоблокированных источников.
    yt_args.extend(proxy_args(&app));

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
        .command(ytdlp_path(&app))
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
            CommandEvent::Terminated(payload) => {
                // Процесс завершён — убираем из реестра активных.
                if let Ok(mut procs) = app.state::<ActiveProcs>().0.lock() {
                    procs.remove(&id);
                }
                // Успех определяем по коду выхода yt-dlp, а не только по числу
                // перемещённых файлов: при «дозакачке» уже готовый файл
                // пропускается (--no-overwrites) и count==0, хотя это не ошибка.
                // Провал — ненулевой код, либо код 0, но был вывод ERROR и ни
                // одного файла (например, весь плейлист упал под --ignore-errors).
                let code_ok = payload.code == Some(0);
                let ok = code_ok && (count > 0 || last_err.is_empty());
                let _ = app.emit(
                    "download://done",
                    DonePayload {
                        id: id.clone(),
                        count,
                        ok,
                        error: if ok {
                            None
                        } else if !last_err.is_empty() {
                            Some(last_err.clone())
                        } else {
                            Some(format!(
                                "Загрузка не завершилась успешно (код {:?})",
                                payload.code
                            ))
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

/// Самообновление yt-dlp: качаем свежий standalone-бинарник с GitHub в app-data
/// (доступную для записи папку). `yt-dlp -U` не годится: бандл лежит рядом с exe,
/// на Windows — в Program Files, куда нет прав на самоперезапись. После загрузки
/// `ytdlp_path` автоматически предпочтёт эту копию бандлу.
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let bin = ytdlp_writable(&app).ok_or("Не удалось определить папку приложения")?;
    let dir = bin
        .parent()
        .ok_or("Некорректный путь к бинарнику")?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
        ytdlp_asset_name()
    );
    let client = reqwest::Client::builder()
        .user_agent("Mestia")
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "Не удалось скачать yt-dlp (HTTP {})",
            resp.status().as_u16()
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    // Пишем во временный файл и атомарно заменяем — прерывание не оставит битый бинарь.
    let tmp = dir.join("yt-dlp.download");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &bin).map_err(|e| e.to_string())?;

    // Версия свежескачанного бинарника (для сообщения пользователю).
    let ver = app
        .shell()
        .command(&bin)
        .args(["--version"])
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "обновлено".into());
    Ok(format!("yt-dlp обновлён до {ver}"))
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

/// Путь к обновляемой копии yt-dlp в app-data (доступна для записи, в отличие от
/// бандл-бинарника рядом с exe — на Windows он лежит в Program Files без прав записи).
fn ytdlp_writable(app: &AppHandle) -> Option<PathBuf> {
    let file = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let dir = app.path().app_data_dir().ok()?.join("bin");
    Some(dir.join(file))
}

/// Путь к yt-dlp: сперва обновлённая копия в app-data (если есть), иначе бандл рядом с exe.
pub(crate) fn ytdlp_path(app: &AppHandle) -> PathBuf {
    if let Some(p) = ytdlp_writable(app) {
        if p.exists() {
            return p;
        }
    }
    binary_path("yt-dlp")
}

/// Имя релиз-ассета yt-dlp на GitHub под текущую ОС/архитектуру (standalone-сборки).
fn ytdlp_asset_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "yt-dlp.exe"
    }
    #[cfg(target_os = "macos")]
    {
        "yt-dlp_macos"
    }
    #[cfg(target_os = "linux")]
    {
        match std::env::consts::ARCH {
            "aarch64" => "yt-dlp_linux_aarch64",
            "arm" => "yt-dlp_linux_armv7l",
            _ => "yt-dlp_linux",
        }
    }
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

// ── Резолв ссылок музыкальных сервисов в поисковый запрос ──────────────────────

/// Преобразует входную ссылку в то, что реально передаём yt-dlp:
/// - Spotify / Apple Music → `ytsearch1:Исполнитель Название` (своих экстракторов нет, DRM);
/// - VK Music / Звук → `Err("MANUAL_QUERY:<сервис>")` — имя из URL не достать, фронтенд
///   просит ввести запрос вручную;
/// - всё остальное (YouTube, SoundCloud, Yandex Music, Bandcamp, готовый `ytsearch…`) — без изменений.
pub async fn resolve_input(url: &str) -> Result<String, String> {
    // Сначала чистим ссылку (трекинг-параметры, ловушка «видео+плейлист»).
    let normalized = normalize_url(url);
    let u = normalized.as_str();
    let low = u.to_lowercase();

    // Уже поисковый запрос — отдаём как есть.
    if low.starts_with("ytsearch") || low.starts_with("scsearch") {
        return Ok(u.to_string());
    }

    // Жёсткий DRM: видео/аудио за Widevine/FairPlay — скачать нельзя в принципе.
    // Не тратим время пользователя на заведомо провальный запуск yt-dlp — сразу
    // честная финальная ошибка. Фронтенд по маркеру `DRM:` не предлагает действий.
    const DRM_HOSTS: &[&str] = &[
        "netflix.com", "music.yandex.", "kinopoisk.", "hd.kinopoisk", "okko.tv",
        "wink.ru", "more.tv", "ivi.ru", "start.ru", "premier.one",
        "disneyplus.com", "hbomax.com", "max.com", "primevideo.com",
        "hulu.com", "tv.apple.com", "play.max.com",
    ];
    if DRM_HOSTS.iter().any(|h| low.contains(h)) {
        let svc = DRM_HOSTS
            .iter()
            .find(|h| low.contains(**h))
            .map(|h| h.trim_end_matches('.'))
            .unwrap_or("stream");
        return Err(format!("DRM:{svc}"));
    }

    if low.contains("open.spotify.com") || low.starts_with("spotify:") {
        return match spotify_query(u).await {
            Some(q) => Ok(format!("ytsearch1:{q}")),
            None => Err("MANUAL_QUERY:spotify".into()),
        };
    }
    if low.contains("music.apple.com") {
        return match apple_query(u).await {
            Some(q) => Ok(format!("ytsearch1:{q}")),
            None => Err("MANUAL_QUERY:apple".into()),
        };
    }
    if low.contains("zvuk.com") {
        return Err("MANUAL_QUERY:zvuk".into());
    }
    // VK-аудио/музыка (но не обычные видео vk.com/video…).
    if (low.contains("vk.com") || low.contains("vkontakte"))
        && (low.contains("/audio") || low.contains("/music") || low.contains("audio_playlist"))
    {
        return Err("MANUAL_QUERY:vk".into());
    }

    Ok(u.to_string())
}

/// GET с коротким таймаутом; None при любой сетевой/HTTP-ошибке.
async fn http_get_text(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.text().await.ok()
}

/// «Исполнитель Название» трека Spotify: основной путь — embed-страница (даёт и
/// исполнителя, и название), запасной — официальный oEmbed (стабилен, но обычно
/// только название). Никогда не падаем жёстко — при неудаче выше сработает MANUAL_QUERY.
async fn spotify_query(url: &str) -> Option<String> {
    if let Some(q) = spotify_scrape(url).await {
        return Some(q);
    }
    spotify_oembed(url).await
}

/// Разбор встроенной (embed) страницы трека: "artists":[{"name":"…"}], "title":"…".
async fn spotify_scrape(url: &str) -> Option<String> {
    let id = spotify_track_id(url)?;
    let html = http_get_text(&format!("https://open.spotify.com/embed/track/{id}")).await?;
    let title = json_str_after(&html, "\"title\":\"")?;
    let artist = json_str_after(&html, "\"artists\":[{\"name\":\"")?;
    Some(format!("{artist} {title}"))
}

/// Официальный oEmbed Spotify — стабильный JSON, но `title` часто без исполнителя.
async fn spotify_oembed(url: &str) -> Option<String> {
    let body = http_get_text(&format!("https://open.spotify.com/oembed?url={url}")).await?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let title = v.get("title").and_then(Value::as_str)?.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// ID трека Spotify из ссылки (`/track/ID`, `spotify:track:ID`).
fn spotify_track_id(url: &str) -> Option<String> {
    let tail = url
        .strip_prefix("spotify:track:")
        .map(str::to_string)
        .or_else(|| url.split("/track/").nth(1).map(str::to_string))?;
    let id: String = tail.chars().take_while(char::is_ascii_alphanumeric).collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// «Исполнитель Название» из iTunes Lookup API по ID трека Apple Music.
async fn apple_query(url: &str) -> Option<String> {
    let id = apple_track_id(url)?;
    let body = http_get_text(&format!("https://itunes.apple.com/lookup?id={id}&entity=song")).await?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let results = v.get("results")?.as_array()?;
    let track = results
        .iter()
        .find(|x| x.get("wrapperType").and_then(Value::as_str) == Some("track"))
        .or_else(|| results.first())?;
    let artist = track.get("artistName").and_then(Value::as_str)?;
    let name = track.get("trackName").and_then(Value::as_str)?;
    Some(format!("{artist} {name}"))
}

/// ID трека Apple Music: приоритет у `?i=`, иначе последний числовой сегмент пути.
fn apple_track_id(url: &str) -> Option<String> {
    if let Some(q) = url.split('?').nth(1) {
        for kv in q.split('&') {
            if let Some(v) = kv.strip_prefix("i=") {
                let id: String = v.chars().take_while(char::is_ascii_digit).collect();
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
    }
    url.split('?')
        .next()
        .unwrap_or(url)
        .split('/')
        .filter(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
        .last()
        .map(String::from)
}

/// Читает JSON-строку, идущую сразу после маркера (маркер включает открывающую кавычку),
/// до неэкранированной кавычки, и декодирует escape-последовательности (\uXXXX, \" …).
fn json_str_after(s: &str, marker: &str) -> Option<String> {
    let start = s.find(marker)? + marker.len();
    let bytes = s.as_bytes();
    let mut i = start;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            // Чётное число предшествующих '\' → кавычка не экранирована.
            let mut bs = 0;
            while i - bs > start && bytes[i - bs - 1] == b'\\' {
                bs += 1;
            }
            if bs % 2 == 0 {
                break;
            }
        }
        i += 1;
    }
    let raw = &s[start..i];
    serde_json::from_str::<String>(&format!("\"{raw}\"")).ok()
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

    #[test]
    fn normalize_strips_playlist_trap_and_tracking() {
        // watch с v= и list=/index= → остаётся только одиночное видео
        assert_eq!(
            normalize_url("https://www.youtube.com/watch?v=abc123&list=RD123&index=4"),
            "https://www.youtube.com/watch?v=abc123"
        );
        // сохраняем таймкод, выкидываем трекинг
        assert_eq!(
            normalize_url("https://youtube.com/watch?v=abc&t=30s&utm_source=x&si=y"),
            "https://youtube.com/watch?v=abc&t=30s"
        );
        // чистый плейлист (без v=) не трогаем
        assert_eq!(
            normalize_url("https://www.youtube.com/playlist?list=PL42"),
            "https://www.youtube.com/playlist?list=PL42"
        );
        // короткая ссылка: si убирается, остаётся путь
        assert_eq!(normalize_url("https://youtu.be/abc?si=xyz"), "https://youtu.be/abc");
        // не-YouTube: трекинг снимаем, остальное храним
        assert_eq!(
            normalize_url("https://rutube.ru/video/abc/?utm_medium=share"),
            "https://rutube.ru/video/abc/"
        );
        // не-http (поиск/схема) — без изменений
        assert_eq!(normalize_url("ytsearch1:rick astley"), "ytsearch1:rick astley");
        assert_eq!(normalize_url("spotify:track:xyz"), "spotify:track:xyz");
    }

    #[test]
    fn spotify_id_from_url_and_uri() {
        assert_eq!(
            spotify_track_id("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x"),
            Some("4cOdK2wGLETKBW3PvgPWqT".into())
        );
        assert_eq!(
            spotify_track_id("https://open.spotify.com/intl-ru/track/4cOdK2wGLETKBW3PvgPWqT"),
            Some("4cOdK2wGLETKBW3PvgPWqT".into())
        );
        assert_eq!(
            spotify_track_id("spotify:track:4cOdK2wGLETKBW3PvgPWqT"),
            Some("4cOdK2wGLETKBW3PvgPWqT".into())
        );
        assert_eq!(spotify_track_id("https://open.spotify.com/playlist/123"), None);
    }

    #[test]
    fn apple_id_prefers_query_then_path() {
        // ?i= имеет приоритет (трек внутри альбома)
        assert_eq!(
            apple_track_id("https://music.apple.com/us/album/x/1558533900?i=1558534271"),
            Some("1558534271".into())
        );
        // иначе — числовой сегмент пути (ссылка на песню)
        assert_eq!(
            apple_track_id("https://music.apple.com/us/song/never-gonna/1559885421"),
            Some("1559885421".into())
        );
        assert_eq!(apple_track_id("https://music.apple.com/us/artist/rick-astley"), None);
    }

    #[test]
    fn json_str_after_decodes_escapes() {
        let html = r#"...{"artists":[{"name":"Rick Astley","uri":"x"}],"title":"Never Gonna"}..."#;
        assert_eq!(
            json_str_after(html, "\"artists\":[{\"name\":\""),
            Some("Rick Astley".into())
        );
        assert_eq!(json_str_after(html, "\"title\":\""), Some("Never Gonna".into()));
        // \uXXXX и \" декодируются
        let esc = r#"{"title":"Aé \"B\""}"#;
        assert_eq!(json_str_after(esc, "\"title\":\""), Some("Aé \"B\"".into()));
        // маркера нет
        assert_eq!(json_str_after(html, "\"missing\":\""), None);
    }
}
