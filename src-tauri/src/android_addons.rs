//! APK-модули Android. Рабочий процесс запускается только из установленного split APK.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::{io::AsyncWriteExt, sync::Mutex};

use crate::{
    addon_runtime::{close_worker, error, AddonId, AddonWorkers, PackageStatus, Reply, Worker},
    addon_wire::AndroidAction,
    mobile,
};

const MAX_APK: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub struct InstallLock(Mutex<()>);

#[derive(Default)]
pub(crate) struct NearbySystem {
    multicast: bool,
    transfers: HashSet<String>,
}

impl NearbySystem {
    pub(crate) fn apply(&mut self, app: &AppHandle, action: AndroidAction) {
        match action {
            AndroidAction::Multicast { on } => {
                self.multicast = on;
                mobile::multicast_lock(app, on);
            }
            AndroidAction::KeepAwake { id, on } => {
                if on {
                    self.transfers.insert(id.clone());
                } else {
                    self.transfers.remove(&id);
                }
                mobile::keep_awake(app, &id, on);
            }
            AndroidAction::Progress { id, name, percent } => {
                mobile::download_progress(app, &id, Some(&name), percent);
            }
            AndroidAction::Scan { path } => mobile::scan_file(app, &path),
        }
    }

    pub(crate) fn release(self, app: &AppHandle) {
        if self.multicast {
            mobile::multicast_lock(app, false);
        }
        for id in self.transfers {
            mobile::keep_awake(app, &id, false);
        }
    }
}

fn filename(id: AddonId, version: &str) -> Result<String, String> {
    let abi = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "arm" => "armv7",
        "x86_64" => "x86_64",
        _ => return Err("Для этого процессора нет APK-модулей".into()),
    };
    Ok(format!(
        "Mestia_Addon_{}_{version}_android_{abi}.apk",
        id.name()
    ))
}

async fn download(
    cache: &Path,
    filename: &str,
    version: &str,
    path: &Path,
    progress: &Channel<u64>,
) -> Result<(), String> {
    // Тестовый APK берём только из закрытого кэша debug-сборки. Подпись проверяет Android.
    #[cfg(debug_assertions)]
    {
        let fixture = cache.join("addon-fixtures").join(filename);
        if let Ok(meta) = tokio::fs::metadata(&fixture).await {
            if meta.len() > MAX_APK {
                return Err("Дополнение превышает допустимый размер".into());
            }
            let size = tokio::fs::copy(fixture, path).await.map_err(error)?;
            let _ = progress.send(size);
            return Ok(());
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = cache;
    let url =
        format!("https://github.com/kweharmony/Mestia/releases/download/v{version}/{filename}");
    let mut response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(error)?
        .get(url)
        .send()
        .await
        .map_err(error)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Пакет ещё не опубликован для этой версии Mestia".into());
    }
    response = response.error_for_status().map_err(error)?;
    let mut bytes = 0;
    let mut file = tokio::fs::File::create(path).await.map_err(error)?;
    while let Some(chunk) = response.chunk().await.map_err(error)? {
        bytes += chunk.len() as u64;
        if bytes > MAX_APK {
            return Err("Дополнение превышает допустимый размер".into());
        }
        file.write_all(&chunk).await.map_err(error)?;
        let _ = progress.send(bytes);
    }
    file.flush().await.map_err(error)
}

#[tauri::command(async)]
pub fn addon_packages(app: AppHandle) -> Result<Value, String> {
    mobile::addon_packages(&app)
}

#[tauri::command]
pub async fn install_addon_package(
    app: AppHandle,
    id: AddonId,
    progress: Channel<u64>,
) -> Result<PackageStatus, String> {
    let install = app.state::<InstallLock>();
    let _install = install
        .0
        .try_lock()
        .map_err(|_| "Другая установка уже выполняется")?;
    let workers = app.state::<AddonWorkers>();
    let mut slot = workers.slot(id).lock().await;
    let version = app.package_info().version.to_string();
    let cache = app.path().app_cache_dir().map_err(error)?;
    let pending = tempfile::Builder::new()
        .prefix("mestia-addon-")
        .suffix(".apk")
        .tempfile_in(&cache)
        .map_err(error)?
        .into_temp_path();
    download(
        &cache,
        &filename(id, &version)?,
        &version,
        &pending,
        &progress,
    )
    .await?;
    close_worker(&mut slot).await?;
    mobile::change_addon(&app, id.name(), Some(&pending)).await?;
    let status =
        serde_json::from_value::<PackageStatus>(mobile::addon_packages(&app)?[id.name()].clone())
            .map_err(error)?;
    if !status.installed {
        return Err("Android не установил модуль для этого процессора".into());
    }
    Ok(status)
}

#[tauri::command]
pub async fn uninstall_addon_package(app: AppHandle, id: AddonId) -> Result<(), String> {
    let install = app.state::<InstallLock>();
    let _install = install
        .0
        .try_lock()
        .map_err(|_| "Другая установка уже выполняется")?;
    let workers = app.state::<AddonWorkers>();
    let mut slot = workers.slot(id).lock().await;
    close_worker(&mut slot).await?;
    mobile::change_addon(&app, id.name(), None).await
}

#[tauri::command]
pub async fn addon_command(app: AppHandle, id: AddonId, command: String, args: Value) -> Reply {
    let workers = app.state::<AddonWorkers>();
    let mut slot = workers.slot(id).lock().await;
    let alive = match slot.as_mut() {
        Some(worker) => worker.child.try_wait().map_err(error)?.is_none(),
        None => false,
    };
    if !alive {
        let app = app.clone();
        *slot = Some(
            tauri::async_runtime::spawn_blocking(move || {
                let path: PathBuf = mobile::addon_worker(&app, id.name())?;
                if path.file_name().and_then(|name| name.to_str()) != Some(id.executable()) {
                    return Err("Недопустимый рабочий файл дополнения".into());
                }
                Worker::start(&app, id, &path)
            })
            .await
            .map_err(error)??,
        );
    }
    let reply = slot
        .as_mut()
        .ok_or("Не удалось запустить дополнение")?
        .request(command, args)
        .await?;
    drop(slot);
    reply
        .await
        .map_err(|_| "Рабочий процесс дополнения завершился".to_owned())?
}
