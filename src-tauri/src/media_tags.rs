use std::path::{Path, PathBuf};

const EDITABLE_TAGS: &[&str] = &[
    "title",
    "artist",
    "album",
    "album_artist",
    "genre",
    "date",
    "track",
    "disc",
    "composer",
    "comment",
    "director",
    "description",
    "show",
    "season_number",
    "episode_sort",
];

pub(crate) fn tag_media_path(root: &Path, path: String) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.starts_with(root) || !path.is_file() {
        return Err("Выберите файл из медиатеки Mestia".into());
    }
    if ![
        "mp3", "flac", "m4a", "mp4", "m4v", "mov", "mkv", "webm", "ogg", "oga", "opus",
    ]
    .contains(&extension.as_str())
    {
        return Err("Редактирование тегов для этого формата недоступно".into());
    }
    Ok(path)
}

pub(crate) fn probe_tags(
    path: &Path,
    ffprobe: &Path,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut command = crate::desktop_process::command(ffprobe);
    let stream_tags = uses_stream_tags(path);
    command.args([
        "-v",
        "error",
        "-show_entries",
        if stream_tags {
            "stream_tags"
        } else {
            "format_tags"
        },
        "-of",
        "json",
    ]);
    if stream_tags {
        command.args(["-select_streams", "a:0"]);
    }
    let output = command.arg(path).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let mut tags = std::collections::BTreeMap::new();
    // Ogg и Opus хранят теги на уровне аудиодорожки.
    let source = if stream_tags {
        &value["streams"][0]["tags"]
    } else {
        &value["format"]["tags"]
    };
    if let Some(source) = source.as_object() {
        for (key, value) in source {
            let key = key.to_ascii_lowercase();
            if let Some(value) = value
                .as_str()
                .filter(|_| EDITABLE_TAGS.contains(&key.as_str()))
            {
                tags.insert(key, value.to_owned());
            }
        }
    }
    Ok(tags)
}

fn uses_stream_tags(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["ogg", "oga", "opus"]
                .iter()
                .any(|format| ext.eq_ignore_ascii_case(format))
        })
}

pub(crate) fn rewrite_media_tags(
    path: &Path,
    tags: &std::collections::BTreeMap<String, String>,
    ffmpeg: &Path,
    ffprobe: &Path,
) -> Result<(), String> {
    if tags.is_empty() {
        return Ok(());
    }
    if tags.iter().any(|(key, value)| {
        !EDITABLE_TAGS.contains(&key.as_str()) || value.contains('\0') || value.len() > 16384
    }) {
        return Err("Недопустимое поле или значение тега".into());
    }
    let parent = path.parent().ok_or("Не удалось определить папку файла")?;
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let original = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".mestia-tags-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let temp = tempfile::Builder::new()
        .suffix(&format!(".{ext}"))
        .tempfile_in(staging.path())
        .map_err(|e| e.to_string())?
        .into_temp_path();
    let mut command = crate::desktop_process::command(ffmpeg);
    command
        .args(["-nostdin", "-v", "error", "-y", "-i"])
        .arg(&path)
        .args([
            "-map",
            "0",
            "-c",
            "copy",
            "-map_metadata",
            "0",
            "-map_chapters",
            "0",
        ]);
    let scope = if uses_stream_tags(path) {
        "-metadata:s:a:0"
    } else {
        "-metadata"
    };
    if ["m4a", "mp4", "m4v", "mov"].contains(&ext.as_str()) {
        command.args(["-movflags", "use_metadata_tags"]);
        if ext == "m4v" {
            command.args(["-f", "mp4"]);
        }
    }
    for (key, value) in tags {
        command.arg(scope).arg(format!("{key}={value}"));
    }
    let output = command.arg(&*temp).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    let written = probe_tags(&temp, ffprobe)?;
    if tags
        .iter()
        .any(|(key, value)| written.get(key).map(String::as_str).unwrap_or("") != value)
    {
        return Err("Формат файла не сохранил все указанные теги".into());
    }
    let current = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if original.len() != current.len() || original.modified().ok() != current.modified().ok() {
        return Err("Файл изменился во время редактирования".into());
    }
    std::fs::set_permissions(&temp, original.permissions()).map_err(|e| e.to_string())?;
    temp.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_worker_only_accepts_supported_media_inside_library() {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let track = library.join("track.mp3");
        let text = library.join("notes.txt");
        let outside = temp.path().join("track.mp3");
        for file in [&track, &text, &outside] {
            std::fs::write(file, b"sample").unwrap();
        }
        assert!(tag_media_path(&library, track.to_string_lossy().into_owned()).is_ok());
        assert!(tag_media_path(&library, text.to_string_lossy().into_owned()).is_err());
        assert!(tag_media_path(&library, outside.to_string_lossy().into_owned()).is_err());
    }
}
