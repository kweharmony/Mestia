#[path = "../../src/addon_wire.rs"]
pub mod wire;

use std::{future::Future, io::Write, path::PathBuf, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use wire::{Message, Request};

#[derive(Clone)]
pub struct Host {
    settings: Arc<PathBuf>,
    default_root: Arc<PathBuf>,
}

impl Host {
    pub fn from_environment() -> Result<Self, String> {
        Ok(Self {
            settings: Arc::new(env_path("MESTIA_ADDON_SETTINGS")?),
            default_root: Arc::new(env_path("MESTIA_ADDON_ROOT")?),
        })
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        let contents = std::fs::read(&*self.settings).ok()?;
        let settings: Value = serde_json::from_slice(&contents).ok()?;
        settings.get(key)?.as_str().map(str::to_owned)
    }

    pub fn storage_root(&self) -> Result<PathBuf, String> {
        let root = self
            .setting("downloadDir")
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| (*self.default_root).clone());
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(root)
    }
}

pub fn env_path(name: &str) -> Result<PathBuf, String> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("Пакет запущен без параметра {name}"))
}

pub fn emit(message: Message) -> Result<(), String> {
    let mut json = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    json.push(b'\n');
    let mut out = std::io::stdout().lock();
    out.write_all(&json)
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}

pub fn value(data: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(data).map_err(|e| e.to_string())
}

pub async fn serve<F, Fut>(dispatch: F)
where
    F: Fn(String, Value) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Result<Value, String>> + Send + 'static,
{
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            continue;
        };
        let dispatch = dispatch.clone();
        tokio::spawn(async move {
            let result = dispatch(request.command, request.args).await;
            let _ = emit(Message::Result {
                id: request.id,
                result,
            });
        });
    }
}
