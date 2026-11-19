//! Общий запуск рабочих процессов дополнений на Windows x64 и Android.

use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

use crate::addon_wire::{Message, Request};

pub(crate) fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddonId {
    Tags,
    Nearby,
}

impl AddonId {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Tags => "tags",
            Self::Nearby => "nearby",
        }
    }

    #[cfg(windows)]
    pub(crate) fn executable(self) -> &'static str {
        match self {
            Self::Tags => "mestia-addon-tags.exe",
            Self::Nearby => "mestia-addon-nearby.exe",
        }
    }

    #[cfg(target_os = "android")]
    pub(crate) fn executable(self) -> &'static str {
        match self {
            Self::Tags => "libmestia_addon_tags.so",
            Self::Nearby => "libmestia_addon_nearby.so",
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct PackageStatus {
    pub(crate) installed: bool,
    pub(crate) present: bool,
    pub(crate) bytes: u64,
}

pub(crate) type Reply = Result<Value, String>;
type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Reply>>>>;

pub(crate) struct Worker {
    pub(crate) child: Child,
    input: ChildStdin,
    pending: Pending,
    next: u64,
}

impl Worker {
    pub(crate) fn start(app: &AppHandle, id: AddonId, path: &Path) -> Result<Self, String> {
        if id == AddonId::Nearby
            && crate::storage::setting(app, "lanId").is_none_or(|id| id.is_empty())
        {
            crate::storage::write_setting(
                app,
                "lanId",
                serde_json::json!(crate::local_network::rand_id()),
            )?;
        }
        let mut command = Command::new(path);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(windows)]
        let default_root = crate::storage::desktop_storage_root(app)
            .or_else(|_| crate::storage::storage_root(app))?;
        #[cfg(target_os = "android")]
        let default_root = crate::mobile::default_storage_root(app)?;
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("MESTIA_ADDON_SETTINGS", crate::storage::settings_file(app)?)
            .env("MESTIA_ADDON_ROOT", default_root);
        #[cfg(windows)]
        if id == AddonId::Tags {
            if let Some(path) = crate::transcription::program("ffmpeg") {
                command.env("MESTIA_ADDON_FFMPEG", path);
            }
            if let Some(path) = crate::transcription::program("ffprobe") {
                command.env("MESTIA_ADDON_FFPROBE", path);
            }
        }
        #[cfg(target_os = "android")]
        if id == AddonId::Tags {
            let tools = crate::mobile::addon_tag_tools(app)?;
            command
                .env("MESTIA_ADDON_FFMPEG", tools.ffmpeg)
                .env("MESTIA_ADDON_FFPROBE", tools.ffprobe)
                .env("MESTIA_ADDON_FFMPEG_LIBS", tools.libs);
        } else if let Some(name) = crate::mobile::device_name(app) {
            command.env("MESTIA_ADDON_DEVICE_NAME", name);
        }
        let mut child = command.spawn().map_err(error)?;
        let input = child.stdin.take().ok_or("Не удалось подключить пакет")?;
        let output = child.stdout.take().ok_or("Не удалось подключить пакет")?;
        let pending = Pending::default();
        let replies = pending.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(target_os = "android")]
            let mut android = crate::android_addons::NearbySystem::default();
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str(&line) {
                    Ok(Message::Result { id, result }) => {
                        if let Some(reply) = replies
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&id)
                        {
                            let _ = reply.send(result);
                        }
                    }
                    Ok(Message::Event { name, payload })
                        if id == AddonId::Nearby && name.starts_with("lan://") =>
                    {
                        let _ = app.emit(&name, payload);
                    }
                    #[cfg(target_os = "android")]
                    Ok(Message::Android { action }) if id == AddonId::Nearby => {
                        let host = app.clone();
                        android = tauri::async_runtime::spawn_blocking(move || {
                            android.apply(&host, action);
                            android
                        })
                        .await
                        .unwrap_or_default();
                    }
                    _ => {}
                }
            }
            replies.lock().unwrap_or_else(|e| e.into_inner()).clear();
            #[cfg(target_os = "android")]
            let _ = tauri::async_runtime::spawn_blocking(move || android.release(&app)).await;
        });
        Ok(Self {
            child,
            input,
            pending,
            next: 0,
        })
    }

    pub(crate) async fn request(
        &mut self,
        command: String,
        args: Value,
    ) -> Result<oneshot::Receiver<Reply>, String> {
        self.next += 1;
        let id = self.next;
        let mut bytes = serde_json::to_vec(&Request { id, command, args }).map_err(error)?;
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        if let Err(e) = self.input.write_all(&bytes).await {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(error(e));
        }
        Ok(receiver)
    }
}

#[derive(Default)]
pub struct AddonWorkers {
    tags: Mutex<Option<Worker>>,
    nearby: Mutex<Option<Worker>>,
}

impl AddonWorkers {
    pub(crate) fn slot(&self, id: AddonId) -> &Mutex<Option<Worker>> {
        match id {
            AddonId::Tags => &self.tags,
            AddonId::Nearby => &self.nearby,
        }
    }
}

pub(crate) async fn close_worker(slot: &mut Option<Worker>) -> Result<(), String> {
    if let Some(worker) = slot.as_mut() {
        if !worker
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
        {
            return Err("Дополнение ещё выполняет задачу".into());
        }
        if worker.child.try_wait().map_err(error)?.is_none() {
            worker.child.kill().await.map_err(error)?;
        }
    }
    *slot = None;
    Ok(())
}
