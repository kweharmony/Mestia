//! Установка официальных пакетов Windows x64 и связь с их рабочими процессами.

use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, AppHandle, Manager};
use crate::addon_runtime::{close_worker, error, AddonId, AddonWorkers, PackageStatus, Reply, Worker};

const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
const MANIFEST_BYTES: usize = 8192;
const WORKER_FILE: &str = "worker.exe";
const MANIFEST_FILE: &str = "manifest.json";
const SIGNATURE_FILE: &str = "manifest.json.sig";

#[derive(Deserialize)]
struct Manifest {
    id: AddonId,
    version: String,
    bytes: usize,
    sha256: String,
}

struct Package {
    manifest: Vec<u8>,
    signature: Vec<u8>,
    executable: Vec<u8>,
}

fn packages_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(error)?
        .join("downloaded-addons"))
}

fn key(app: &AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("MESTIA_ADDON_DEV_PUBKEY") {
        return Ok(key);
    }
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater["pubkey"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Не настроен ключ проверки дополнений".into())
}

fn bounded(mut input: impl Read, max: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > max {
        return Err("Дополнение превышает допустимый размер".into());
    }
    Ok(bytes)
}

fn signed_manifest(
    raw: &[u8],
    signature: &[u8],
    public_key: &str,
    id: AddonId,
    version: &str,
) -> Result<Manifest, String> {
    let decode = |encoded: &[u8]| -> Result<String, String> {
        let encoded = std::str::from_utf8(encoded).map_err(error)?.trim();
        String::from_utf8(STANDARD.decode(encoded).map_err(error)?).map_err(error)
    };
    let key = PublicKey::decode(&decode(public_key.as_bytes())?).map_err(error)?;
    let signature = Signature::decode(&decode(signature)?).map_err(error)?;
    key.verify(raw, &signature, false)
        .map_err(|_| "Подпись дополнения не прошла проверку")?;
    let manifest: Manifest = serde_json::from_slice(raw).map_err(error)?;
    if manifest.id != id
        || manifest.version != version
        || !(1..=MAX_PACKAGE_BYTES).contains(&manifest.bytes)
    {
        return Err("Пакет не подходит к этой версии Mestia".into());
    }
    Ok(manifest)
}

fn verify_executable(manifest: &Manifest, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() != manifest.bytes || format!("{:x}", Sha256::digest(bytes)) != manifest.sha256 {
        return Err("Контрольная сумма дополнения не совпала".into());
    }
    Ok(())
}

fn unpack(bytes: &[u8], public_key: &str, id: AddonId, version: &str) -> Result<Package, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(error)?;
    if archive.len() != 3 {
        return Err("Некорректный архив дополнения".into());
    }
    let manifest = bounded(
        archive.by_name(MANIFEST_FILE).map_err(error)?,
        MANIFEST_BYTES,
    )?;
    let signature = bounded(
        archive.by_name(SIGNATURE_FILE).map_err(error)?,
        MANIFEST_BYTES,
    )?;
    let checked = signed_manifest(&manifest, &signature, public_key, id, version)?;
    let executable = bounded(archive.by_name(WORKER_FILE).map_err(error)?, checked.bytes)?;
    verify_executable(&checked, &executable)?;
    Ok(Package {
        manifest,
        signature,
        executable,
    })
}

fn installed_worker(
    directory: &Path,
    public_key: &str,
    id: AddonId,
    version: &str,
) -> Result<PathBuf, String> {
    let read = |name: &str, max| {
        bounded(
            std::fs::File::open(directory.join(name)).map_err(error)?,
            max,
        )
    };
    let raw = read(MANIFEST_FILE, MANIFEST_BYTES)?;
    let signature = read(SIGNATURE_FILE, MANIFEST_BYTES)?;
    let manifest = signed_manifest(&raw, &signature, public_key, id, version)?;
    verify_executable(&manifest, &read(id.executable(), manifest.bytes)?)?;
    Ok(directory.join(id.executable()))
}

fn install_package(parent: &Path, id: AddonId, package: Package) -> Result<(), String> {
    std::fs::create_dir_all(parent).map_err(error)?;
    let stage = tempfile::tempdir_in(parent).map_err(error)?;
    std::fs::write(stage.path().join(id.executable()), package.executable).map_err(error)?;
    std::fs::write(stage.path().join(MANIFEST_FILE), package.manifest).map_err(error)?;
    std::fs::write(stage.path().join(SIGNATURE_FILE), package.signature).map_err(error)?;
    let destination = parent.join(id.name());
    let retired = tempfile::tempdir_in(parent).map_err(error)?;
    let backup = retired.path().join("previous");
    if destination.exists() {
        std::fs::rename(&destination, &backup).map_err(error)?;
    }
    if let Err(e) = std::fs::rename(stage.path(), &destination) {
        if backup.exists() && std::fs::rename(&backup, &destination).is_err() {
            let _ = retired.keep();
        }
        return Err(error(e));
    }
    Ok(())
}

async fn download(id: AddonId, version: &str, progress: &Channel<u64>) -> Result<Vec<u8>, String> {
    let filename = format!("Mestia_Addon_{}_{version}_windows_x64.zip", id.name());
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("MESTIA_ADDON_DEV_DIR") {
        let file = std::fs::File::open(PathBuf::from(dir).join(filename)).map_err(error)?;
        return bounded(file, MAX_PACKAGE_BYTES);
    }
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
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(error)? {
        if bytes.len() + chunk.len() > MAX_PACKAGE_BYTES {
            return Err("Дополнение превышает допустимый размер".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = progress.send(bytes.len() as u64);
    }
    Ok(bytes)
}

#[tauri::command(async)]
pub fn addon_packages(app: AppHandle) -> Result<Value, String> {
    let parent = packages_dir(&app)?;
    let key = key(&app)?;
    let version = app.package_info().version.to_string();
    let status = |id: AddonId| {
        let directory = parent.join(id.name());
        PackageStatus {
            installed: installed_worker(&directory, &key, id, &version).is_ok(),
            present: directory.exists(),
            bytes: directory
                .join(id.executable())
                .metadata()
                .map(|file| file.len())
                .unwrap_or(0),
        }
    };
    Ok(serde_json::json!({ "tags": status(AddonId::Tags), "nearby": status(AddonId::Nearby) }))
}

#[tauri::command]
pub async fn install_addon_package(
    app: AppHandle,
    id: AddonId,
    progress: Channel<u64>,
) -> Result<PackageStatus, String> {
    let workers = app.state::<AddonWorkers>();
    let mut slot = workers.slot(id).lock().await;
    let version = app.package_info().version.to_string();
    let key = key(&app)?;
    let parent = packages_dir(&app)?;
    let bytes = download(id, &version, &progress).await?;
    let package = tauri::async_runtime::spawn_blocking(move || unpack(&bytes, &key, id, &version))
        .await
        .map_err(error)??;
    let bytes = package.executable.len() as u64;
    close_worker(&mut slot).await?;
    tauri::async_runtime::spawn_blocking(move || install_package(&parent, id, package))
        .await
        .map_err(error)??;
    Ok(PackageStatus {
        installed: true,
        present: true,
        bytes,
    })
}

#[tauri::command]
pub async fn uninstall_addon_package(app: AppHandle, id: AddonId) -> Result<(), String> {
    let workers = app.state::<AddonWorkers>();
    let mut slot = workers.slot(id).lock().await;
    close_worker(&mut slot).await?;
    match tokio::fs::remove_dir_all(packages_dir(&app)?.join(id.name())).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(error(e)),
        _ => Ok(()),
    }
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
        let directory = packages_dir(&app)?.join(id.name());
        let key = key(&app)?;
        let version = app.package_info().version.to_string();
        let path = tauri::async_runtime::spawn_blocking(move || {
            installed_worker(&directory, &key, id, &version)
        })
        .await
        .map_err(error)?
        .map_err(|_| "Сначала установите актуальный пакет в каталоге дополнений")?;
        *slot = Some(Worker::start(&app, id, &path)?);
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
