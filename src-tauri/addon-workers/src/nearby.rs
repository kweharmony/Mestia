#[path = "../../src/file_paths.rs"]
mod file_paths;
#[path = "../../src/lan.rs"]
mod lan;
#[path = "../../src/local_network.rs"]
mod local_network;

use std::sync::Arc;

use mestia_addon_workers::{emit, serve, value, wire::Message, Host};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone)]
struct AppHandle {
    lan: Arc<lan::Lan>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    host: Host,
    fallback_id: Arc<String>,
}

impl AppHandle {
    fn emit(&self, name: &str, payload: impl Serialize) -> Result<(), String> {
        emit(Message::Event {
            name: name.into(),
            payload: value(payload)?,
        })
    }
}

mod storage {
    use super::AppHandle;
    use std::path::PathBuf;

    pub fn setting(app: &AppHandle, key: &str) -> Option<String> {
        app.host
            .setting(key)
            .filter(|value| !value.is_empty())
            .or_else(|| (key == "lanId").then(|| (*app.fallback_id).clone()))
    }

    pub fn storage_root(app: &AppHandle) -> Result<PathBuf, String> {
        app.host.storage_root()
    }
}

#[cfg(mobile)]
mod mobile {
    use super::{emit, AppHandle, Message};
    use mestia_addon_workers::wire::AndroidAction;

    pub fn device_name(_: &AppHandle) -> Option<String> {
        std::env::var("MESTIA_ADDON_DEVICE_NAME").ok()
    }

    pub fn multicast_lock(_: &AppHandle, on: bool) {
        send(AndroidAction::Multicast { on });
    }

    pub fn keep_awake(_: &AppHandle, id: &str, on: bool) {
        send(AndroidAction::KeepAwake { id: id.into(), on });
    }

    pub fn download_progress(_: &AppHandle, id: &str, name: Option<&str>, percent: f64) {
        send(AndroidAction::Progress { id: id.into(), name: name.unwrap_or_default().into(), percent });
    }

    pub fn scan_file(_: &AppHandle, path: &str) {
        send(AndroidAction::Scan { path: path.into() });
    }

    fn send(action: AndroidAction) {
        let _ = emit(Message::Android { action });
    }
}

async fn dispatch(app: AppHandle, command: String, args: Value) -> Result<Value, String> {
    macro_rules! arg {
        ($key:literal) => {
            serde_json::from_value(args[$key].clone()).map_err(|e| e.to_string())?
        };
    }
    match command.as_str() {
        "lan_info" => value(lan::lan_info(app)),
        "lan_peers" => value(lan::lan_peers(app)),
        "lan_start" => {
            let _guard = app.lifecycle.lock().await;
            value(lan::lan_start(app.clone()).await?)
        }
        "lan_stop" => {
            let _guard = app.lifecycle.lock().await;
            value(lan::lan_stop(app.clone()))
        }
        "lan_probe" => value(lan::lan_probe(app, arg!("addr")).await?),
        "lan_answer_offer" => value(lan::lan_answer_offer(app, arg!("id"), arg!("accept"))),
        "lan_send" => value(lan::lan_send(app, arg!("addr"), arg!("peer"), arg!("paths")).await?),
        "lan_room_start" => value(lan::lan_room_start(
            app,
            arg!("path"),
            arg!("title"),
            arg!("kind"),
        )?),
        "lan_room_stop" => value(lan::lan_room_stop(app)),
        "lan_room_state" => value(lan::lan_room_state(
            app,
            arg!("playing"),
            arg!("pos"),
            arg!("rate"),
        )),
        "lan_room_join" => value(lan::lan_room_join(app, arg!("addr")).await?),
        "lan_room_cmd" => value(lan::lan_room_cmd(app, arg!("action"), arg!("pos"))),
        "lan_room_leave" => value(lan::lan_room_leave(app)),
        "lan_room_add" => value(lan::lan_room_add(
            app,
            arg!("path"),
            arg!("title"),
            arg!("kind"),
        )?),
        "lan_room_move" => value(lan::lan_room_move(app, arg!("id"), arg!("delta"))),
        "lan_room_remove" => value(lan::lan_room_remove(app, arg!("id"))),
        "lan_room_play" => value(lan::lan_room_play(app, arg!("id"))),
        "lan_room_queue" => value(lan::lan_room_queue(app)),
        "lan_room_propose" => value(lan::lan_room_propose(
            app,
            arg!("path"),
            arg!("title"),
            arg!("kind"),
        )?),
        _ => Err("Неизвестная команда пакета «Рядом»".into()),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), String> {
    let app = AppHandle {
        lan: Arc::new(lan::Lan::default()),
        lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        host: Host::from_environment()?,
        fallback_id: Arc::new(local_network::rand_id()),
    };
    let handle = app.clone();
    serve(move |command, args| dispatch(handle.clone(), command, args)).await;
    lan::lan_stop(app);
    Ok(())
}
