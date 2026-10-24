//! Мост к Kotlin-плагину `MestiaPlugin` (Android): yt-dlp/ffmpeg из youtubedl-android,
//! foreground-сервис загрузок, превью, открытие файлов, «Поделиться → Mestia».
//! Kotlin-код — `gen/android/app/src/main/java/com/mestia/app/`.
//!
//! Вызовы плагина блокируют поток до ответа Kotlin, поэтому команды, которые
//! сюда ходят, помечены `#[tauri::command(async)]` — не из главного потока.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};

pub struct Mobile<R: Runtime>(PluginHandle<R>);

/// Регистрирует Kotlin-плагин как плагин Tauri `mestia`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mestia")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.mestia.app", "MestiaPlugin")?;
            app.manage(Mobile(handle));
            Ok(())
        })
        .build()
}

pub fn plugin(app: &AppHandle) -> &PluginHandle<Wry> {
    &app.state::<Mobile<Wry>>().inner().0
}

fn call<T: DeserializeOwned>(app: &AppHandle, cmd: &str, payload: impl Serialize) -> Result<T, String> {
    plugin(app).run_mobile_plugin(cmd, payload).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct IdArgs<'a> {
    id: &'a str,
}

#[derive(Serialize)]
struct PathArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
struct PathResult {
    path: String,
}

/// Остановить процесс yt-dlp задачи `id`.
pub fn cancel(app: &AppHandle, id: &str) -> Result<(), String> {
    call::<Value>(app, "cancel", IdArgs { id }).map(|_| ())
}

/// Папка загрузок по умолчанию: Download/Mestia (видна в «Файлах», медиа — в галерее).
pub fn default_storage_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    call::<PathResult>(app, "storageRoot", ()).map(|r| r.path.into())
}

/// Выбор папки загрузок (SAF → путь на диске). None — выбор отменён.
pub fn pick_folder(app: &AppHandle) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Picked {
        #[serde(default)]
        path: Option<String>,
    }
    call::<Picked>(app, "pickFolder", ()).map(|p| p.path)
}

/// Кадр из видео в jpg `out` (MediaMetadataRetriever вместо ffmpeg).
pub fn thumbnail(app: &AppHandle, video: &str, out: &str) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ThumbArgs<'a> {
        video_path: &'a str,
        out_path: &'a str,
    }
    call::<Value>(app, "thumbnail", ThumbArgs { video_path: video, out_path: out }).map(|_| ())
}

/// Открыть файл во внешнем приложении (ACTION_VIEW через FileProvider).
pub fn open_path(app: &AppHandle, path: &str) -> Result<(), String> {
    call::<Value>(app, "openPath", PathArgs { path }).map(|_| ())
}

/// Сообщить MediaStore о новом файле — чтобы он появился в галерее/плеерах.
pub fn scan_file(app: &AppHandle, path: &str) {
    let _ = call::<Value>(app, "scanFile", PathArgs { path });
}

/// Полноэкранный плеер: скрыть системные панели и повернуть экран (или вернуть всё).
pub fn set_fullscreen(app: &AppHandle, on: bool, landscape: bool) {
    #[derive(Serialize)]
    struct Args {
        on: bool,
        landscape: bool,
    }
    let _ = call::<Value>(app, "setFullscreen", Args { on, landscape });
}

/// Свернуть приложение (moveTaskToBack), не завершая процесс.
pub fn move_to_back(app: &AppHandle) {
    let _ = call::<Value>(app, "moveToBack", ());
}

/// Ссылка, присланная через «Поделиться» (забирается один раз).
pub fn take_shared_text(app: &AppHandle) -> Option<String> {
    #[derive(Deserialize)]
    struct Shared {
        #[serde(default)]
        text: Option<String>,
    }
    call::<Shared>(app, "takeShared", ()).ok().and_then(|s| s.text)
}

/// Обновить встроенный yt-dlp; возвращает версию.
pub fn update_ytdlp(app: &AppHandle) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Updated {
        #[serde(default)]
        version: Option<String>,
    }
    call::<Updated>(app, "update", ()).map(|u| u.version.unwrap_or_default())
}
