#[path = "../../src/desktop_process.rs"]
mod desktop_process;
#[path = "../../src/media_tags.rs"]
mod media_tags;

use std::{collections::BTreeMap, sync::Mutex};

use mestia_addon_workers::{env_path, serve, value, Host};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct FileArgs {
    path: String,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

fn edit(host: &Host, command: &str, args: Value) -> Result<Value, String> {
    let args: FileArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let path = media_tags::tag_media_path(&host.storage_root()?, args.path)?;
    let ffprobe = env_path("MESTIA_ADDON_FFPROBE").map_err(|_| "Не найден FFprobe")?;
    match command {
        "read_media_tags" => value(media_tags::probe_tags(&path, &ffprobe)?),
        "write_media_tags" => {
            static EDITING: Mutex<()> = Mutex::new(());
            let _editing = EDITING
                .try_lock()
                .map_err(|_| "Уже сохраняются теги другого файла")?;
            let ffmpeg = env_path("MESTIA_ADDON_FFMPEG").map_err(|_| "Не найден FFmpeg")?;
            value(media_tags::rewrite_media_tags(
                &path, &args.tags, &ffmpeg, &ffprobe,
            )?)
        }
        _ => Err("Неизвестная команда редактора тегов".into()),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), String> {
    let host = Host::from_environment()?;
    serve(move |command, args| {
        let host = host.clone();
        async move {
            tokio::task::spawn_blocking(move || edit(&host, &command, args))
                .await
                .map_err(|e| e.to_string())?
        }
    })
    .await;
    Ok(())
}
