use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const APP_DIR: &str = "Mestia";

/// Активный наблюдатель за папкой библиотеки.
#[derive(Default)]
pub struct LibWatcher(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Начинает следить за папкой (рекурсивно). При изменениях шлёт `library://changed`.
#[tauri::command]
pub fn watch_library(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let app2 = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            // Только появление/удаление/переименование — изменение содержимого
            // (запись .part при скачивании) игнорируем, чтобы не спамить.
            let relevant = matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_))
                || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)));
            if relevant {
                let _ = app2.emit("library://changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Старый watcher дропается (перестаёт следить), заменяем новым.
    *app.state::<LibWatcher>().0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

/// Параллельно проверяет существование путей (файлов/папок).
#[tauri::command]
pub fn existing_paths(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).exists())
        .collect()
}

/// Путь к файлу настроек приложения.
fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Читает все настройки как JSON-объект (или пустой объект).
fn read_settings(app: &tauri::AppHandle) -> serde_json::Map<String, Value> {
    settings_file(app)
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Записывает одно значение настройки, сохраняя остальные ключи.
fn write_setting(app: &tauri::AppHandle, key: &str, value: Value) -> Result<(), String> {
    let mut map = read_settings(app);
    map.insert(key.to_string(), value);
    let body = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    std::fs::write(settings_file(app)?, body).map_err(|e| e.to_string())
}

/// Пользовательская папка загрузок из настроек (если задана).
fn configured_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let s = read_settings(app).get("downloadDir")?.as_str()?.to_string();
    if s.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// Возвращает строковое значение произвольной настройки.
#[tauri::command]
pub fn get_setting(app: tauri::AppHandle, key: String) -> Option<String> {
    read_settings(&app)
        .get(&key)
        .and_then(Value::as_str)
        .map(String::from)
}

/// Сохраняет строковое значение произвольной настройки.
#[tauri::command]
pub fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    write_setting(&app, &key, json!(value))
}

/// Корневая папка хранилища: пользовательская из настроек или Документы/Mestia.
pub(crate) fn storage_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = match configured_dir(app) {
        Some(p) => p,
        None => app
            .path()
            .document_dir()
            .map_err(|e| e.to_string())?
            .join(APP_DIR),
    };
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Задаёт папку загрузок (сохраняется в настройках). Возвращает применённый путь.
#[tauri::command]
pub fn set_storage_root(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    write_setting(&app, "downloadDir", json!(path))?;
    Ok(p.to_string_lossy().to_string())
}

/// Медиафайл, найденный сканированием папки.
#[derive(Serialize)]
pub struct MediaFile {
    path: String,
    name: String,
    size: u64,
}

const MEDIA_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "ts", // видео
    "mp3", "m4a", "wav", "flac", "opus", "aac", "ogg", "oga", // аудио
];

/// Подпапка, найденная сканированием.
#[derive(Serialize)]
pub struct DirEntry {
    path: String,
    name: String,
}

/// Возвращает непосредственные подпапки папки dir (без скрытых).
#[tauri::command]
pub fn scan_dirs(dir: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("папка")
            .to_string();
        if name.starts_with('.') {
            continue; // пропускаем скрытые/системные
        }
        out.push(DirEntry {
            path: p.to_string_lossy().to_string(),
            name,
        });
    }
    Ok(out)
}

/// Возвращает медиафайлы (видео/аудио), лежащие непосредственно в папке dir.
#[tauri::command]
pub fn scan_media(dir: String) -> Result<Vec<MediaFile>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out), // нет папки — просто пусто
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext_ok = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| MEDIA_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !ext_ok {
            continue;
        }
        let name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("файл")
            .to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(MediaFile {
            path: p.to_string_lossy().to_string(),
            name,
            size,
        });
    }
    Ok(out)
}

/// Очистка имени папки от недопустимых для файловой системы символов.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    cleaned.trim().to_string()
}

#[tauri::command]
pub fn get_storage_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(storage_root(&app)?.to_string_lossy().to_string())
}

/// Создаёт папку на диске. Если задан parent (путь родительской папки) —
/// создаёт внутри неё, иначе в корне хранилища. Возвращает путь созданной папки.
#[tauri::command]
pub fn create_folder_dir(
    app: tauri::AppHandle,
    name: String,
    parent: Option<String>,
) -> Result<String, String> {
    let safe = sanitize(&name);
    if safe.is_empty() {
        return Err("Пустое имя папки".into());
    }
    let base = match parent {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => storage_root(&app)?,
    };
    let dir = base.join(&safe);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Перемещает файл видео в указанную папку (абсолютный путь). Возвращает новый путь.
#[tauri::command]
pub fn move_video_file(file_path: String, dest_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&file_path);
    if !src.is_file() {
        return Err("Исходный файл не найден (возможно, перемещён или удалён вне приложения)".into());
    }
    let file_name = src
        .file_name()
        .ok_or_else(|| "Некорректный путь файла".to_string())?;

    let dest_dir = PathBuf::from(&dest_dir);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(file_name);

    // rename работает в пределах одного тома; иначе — copy + remove.
    if std::fs::rename(&src, &dest).is_err() {
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&src);
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Удаляет файл с диска.
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Удаляет папку со всем содержимым.
#[tauri::command]
pub fn delete_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Переименовывает папку (в том же родителе). Возвращает новый путь.
#[tauri::command]
pub fn rename_folder(old_path: String, new_name: String) -> Result<String, String> {
    let safe = sanitize(&new_name);
    if safe.is_empty() {
        return Err("Пустое имя папки".into());
    }
    let old = PathBuf::from(&old_path);
    let parent = old
        .parent()
        .ok_or_else(|| "Нет родительского каталога".to_string())?;
    let new_path = parent.join(&safe);
    std::fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

/// Полный выход из приложения (вызывается из диалога закрытия).
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Удаление приложения. Стирает данные (БД/настройки/кэш превью), при
/// `delete_content == true` — ещё и папку загрузок со скачанным контентом,
/// затем запускает штатную деинсталляцию под текущую ОС. После возврата
/// фронтенд закрывает приложение.
#[tauri::command]
pub fn uninstall_app(app: tauri::AppHandle, delete_content: bool) -> Result<(), String> {
    // 1. Скачанный контент (папка загрузок) — только по согласию пользователя.
    if delete_content {
        if let Ok(root) = storage_root(&app) {
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    // 2. Данные приложения: БД, настройки, кэш превью.
    for dir in [
        app.path().app_config_dir().ok(),
        app.path().app_data_dir().ok(),
        app.path().app_cache_dir().ok(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 3. Запуск деинсталляции под платформу.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // NSIS-деинсталлятор лежит рядом с исполняемым файлом (uninstall.exe).
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let uninstaller = exe
            .parent()
            .ok_or("не найден каталог установки")?
            .join("uninstall.exe");
        if !uninstaller.is_file() {
            return Err("Деинсталлятор не найден (портативный запуск?)".into());
        }
        std::process::Command::new(uninstaller)
            .creation_flags(0x0000_0008) // DETACHED_PROCESS
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        // Самоудаление .app: .../Mestia.app/Contents/MacOS/<bin> → подняться к .app.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if let Some(app_bundle) = exe.ancestors().find(|p| p.extension().map_or(false, |e| e == "app")) {
            let target = app_bundle.to_string_lossy().to_string();
            // Ждём закрытия приложения, затем удаляем бандл.
            std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("sleep 1; rm -rf \"{}\"", target))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(flatpak_id) = std::env::var("FLATPAK_ID") {
            // Внутри песочницы — деинсталляция через портал на хосте.
            let _ = std::process::Command::new("flatpak-spawn")
                .args(["--host", "flatpak", "uninstall", "-y", &flatpak_id])
                .spawn();
        } else if let Ok(appimage) = std::env::var("APPIMAGE") {
            // Портативный AppImage — просто удаляем файл после выхода.
            let _ = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("sleep 1; rm -f \"{}\"", appimage))
                .spawn();
        }
        // Для .deb/.rpm штатно удаляется пакетным менеджером — данные уже стёрты.
    }

    Ok(())
}

/// Запуск ffmpeg без мелькающего окна консоли (Windows).
fn ffmpeg_cmd() -> std::process::Command {
    // `mut` нужен только на Windows (creation_flags) — на других ОС он не используется.
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(crate::downloader::binary_path("ffmpeg"));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Генерирует превью-кадр видео (jpg в кэше приложения). Возвращает путь.
/// Результат кэшируется по хэшу пути — повторные вызовы мгновенны.
#[tauri::command]
pub fn generate_thumbnail(app: tauri::AppHandle, video_path: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    video_path.hash(&mut hasher);
    let out = cache.join(format!("{:016x}.jpg", hasher.finish()));
    if out.is_file() {
        return Ok(out.to_string_lossy().to_string());
    }

    let out_str = out.to_string_lossy().to_string();
    // Кадр с 3-й секунды; для совсем коротких роликов — повтор с начала.
    for ss in ["3", "0"] {
        let status = ffmpeg_cmd()
            .args([
                "-y", "-ss", ss, "-i", &video_path,
                "-frames:v", "1", "-vf", "scale=480:-2", &out_str,
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() && out.is_file() {
            return Ok(out_str);
        }
    }
    Err("Не удалось создать превью".into())
}

/// Открывает указанную папку в системном проводнике.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Открывает системный проводник с выделенным файлом.
#[tauri::command]
pub fn reveal_in_explorer(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", file_path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(std::path::Path::new(&file_path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let path = std::path::Path::new(&file_path);
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
