use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::io::AsyncWriteExt;

const MODELS: [(&str, &str); 9] = [
    ("tiny", "bd577a113a864445d4c299885e0cb97d4ba92b5f"),
    ("base", "465707469ff3a37a2b9b8d8f89f2f99de7299dac"),
    ("small", "55356645c2b361a969dfd0ef2c5a50d530afd8d5"),
    ("large-v3-turbo", "4af2b29d7ec73d781377bfd1758ca957a807e941"),
    ("base.en", "137c40403d78fd54d454da0f9bd998f78703390c"),
    ("small.en", "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022"),
    ("medium", "fd9727b6e1217c2f614f9b698455c4ffd82463b4"),
    ("large-v3-q5_0", "e6e2ed78495d403bef4b7cff42ef4aaadcfea8de"),
    (
        "large-v3-turbo-q5_0",
        "e050f7970618a659205450ad97eb95a18d69c9ee",
    ),
];
const ENGINE_RELEASE: &str = "b5454";
const AUTO_INSTALL: bool = cfg!(all(windows, target_arch = "x86_64"));

fn engine_dir(app: &AppHandle, cuda: bool) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("transcription-engine")
        .join(ENGINE_RELEASE)
        .join(if cuda { "cuda" } else { "cpu" }))
}

fn managed_engine(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.is_dir() {
            return managed_engine(&path);
        }
        (entry.file_name() == "whisper-cli.exe").then_some(path)
    })
}

fn engine_works(path: &Path) -> bool {
    command(path)
        .arg("--help")
        .output()
        .is_ok_and(|output| output.status.success())
}

async fn ensure_engine(
    app: &AppHandle,
    cuda: bool,
    updates: &Channel<Update>,
) -> Result<PathBuf, String> {
    let dir = engine_dir(app, cuda)?;
    if let Some(path) = managed_engine(&dir) {
        let probe = path.clone();
        if tauri::async_runtime::spawn_blocking(move || engine_works(&probe))
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(path);
        }
    }
    if !AUTO_INSTALL {
        return program("whisper-cli").ok_or("Не найден whisper-cli".into());
    }
    if !cuda {
        if let Some(path) = program("whisper-cli") {
            let probe = path.clone();
            if tauri::async_runtime::spawn_blocking(move || engine_works(&probe))
                .await
                .map_err(|e| e.to_string())?
            {
                return Ok(path);
            }
        }
    }
    let (asset, checksum) = if cuda {
        (
            "whisper-bin-win-cuda-12.4.0-x64.zip",
            "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a",
        )
    } else {
        (
            "whisper-bin-x64.zip",
            "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
        )
    };
    let parent = dir.parent().ok_or("Не найден каталог движка")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let archive = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| e.to_string())?
        .into_temp_path();
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| e.to_string())?;
    let mut response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!(
            "https://github.com/ggml-org/whisper.cpp/releases/download/{ENGINE_RELEASE}/{asset}"
        ))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?;
    let mut hash = sha2::Sha256::new();
    let mut bytes = 0;
    let _ = updates.send(Update::Engine(0));
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        hash.update(&chunk);
        bytes += chunk.len() as u64;
        let _ = updates.send(Update::Engine(bytes));
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if format!("{:x}", hash.finalize()) != checksum {
        return Err("Контрольная сумма движка не совпала".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let parent = dir.parent().ok_or("Не найден каталог движка")?;
        let staging = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        zip::ZipArchive::new(file)
            .and_then(|mut zip| zip.extract(staging.path()))
            .map_err(|e| e.to_string())?;
        let executable = managed_engine(staging.path()).ok_or("В архиве нет whisper-cli")?;
        let relative = executable
            .strip_prefix(staging.path())
            .map_err(|e| e.to_string())?;
        if !engine_works(&executable) {
            return Err("Не удалось запустить установленный whisper-cli".into());
        }
        let retired = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
        let backup = retired.path().join("previous");
        if dir.exists() {
            std::fs::rename(&dir, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = std::fs::rename(staging.path(), &dir) {
            if backup.exists() && std::fs::rename(&backup, &dir).is_err() {
                let _ = retired.keep();
            }
            return Err(error.to_string());
        }
        Ok(dir.join(relative))
    })
    .await
    .map_err(|e| e.to_string())?
}
static BUSY: AtomicBool = AtomicBool::new(false);

struct Job;
impl Drop for Job {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

pub(crate) fn program(name: &str) -> Option<PathBuf> {
    let bundled = crate::downloader::binary_path(name);
    if bundled.is_absolute() && bundled.is_file() {
        return Some(bundled);
    }
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|path| path.is_absolute())
        .map(|dir| dir.join(&name))
        .find(|path| path.is_file())
}

pub(crate) fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[derive(Serialize)]
pub struct Info {
    cores: usize,
    recommended: &'static str,
    ready: bool,
    vram: Option<u32>,
}

#[tauri::command]
pub async fn transcription_info() -> Result<Info, String> {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .map_err(|e| e.to_string())
}

fn detect() -> Info {
    let cores = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let vram = program("nvidia-smi")
        .and_then(|path| {
            command(&path)
                .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
                .output()
                .ok()
        })
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .max()
        });
    Info {
        cores,
        vram,
        recommended: if vram.is_some_and(|memory| memory >= 6144) {
            "large-v3-turbo"
        } else if vram.is_some_and(|memory| memory >= 2048) {
            "small"
        } else {
            match cores {
                0..=3 => "tiny",
                4..=7 => "base",
                _ => "small",
            }
        },
        ready: (AUTO_INSTALL || program("whisper-cli").is_some()) && program("ffmpeg").is_some(),
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Update {
    Engine(u64),
    CpuFallback,
    Download(u64),
    Prepare,
    Recognize,
    Log(String),
}

fn run(mut cmd: Command, updates: &Channel<Update>) -> Result<bool, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let cuda = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let read = |pipe: &mut dyn BufRead| {
            for line in pipe.split(b'\n').map_while(Result::ok) {
                let line = String::from_utf8_lossy(&line);
                if line.contains("whisper_backend_init_gpu: using CUDA") {
                    cuda.store(true, Ordering::Relaxed);
                }
                if !line.trim().is_empty() {
                    let _ = updates.send(Update::Log(line.trim().into()));
                }
            }
        };
        scope.spawn(move || read(&mut BufReader::new(stdout)));
        read(&mut BufReader::new(stderr));
    });
    if child.wait().map_err(|e| e.to_string())?.success() {
        Ok(cuda.load(Ordering::Relaxed))
    } else {
        Err("Обработка файла завершилась с ошибкой".into())
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct TranscriptionOptions {
    language: Option<String>,
    translate: bool,
    timestamps: bool,
}

impl TranscriptionOptions {
    fn language_for(&self, model: &str) -> Result<&str, String> {
        let language = self.language.as_deref().unwrap_or("auto");
        if ![
            "auto", "ru", "en", "zh", "uk", "de", "fr", "es", "it", "pt", "ja", "ko", "tr", "ar",
            "hi", "ka",
        ]
        .contains(&language)
        {
            return Err("Язык транскрибации не поддерживается".into());
        }
        if self.translate && (model.ends_with(".en") || model.contains("turbo")) {
            return Err(
                "Выбранная модель не поддерживает перевод. Выберите многоязычную модель без Turbo"
                    .into(),
            );
        }
        // Английские модели игнорируют сохранённый выбор языка.
        Ok(if model.ends_with(".en") {
            "en"
        } else {
            language
        })
    }

    fn output_extension(&self) -> &str {
        if self.timestamps {
            "srt"
        } else {
            "txt"
        }
    }
}

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    model: String,
    path: String,
    updates: Channel<Update>,
    options: Option<TranscriptionOptions>,
) -> Result<String, String> {
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("Транскрибация уже выполняется".into());
    }
    let job = Job;
    let options = options.unwrap_or_default();
    let language = options.language_for(&model)?.to_owned();
    let ffmpeg = program("ffmpeg").ok_or("Не найден FFmpeg")?;
    let root = crate::storage::storage_root(&app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let input = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !input.starts_with(root) || !input.is_file() {
        return Err("Выберите файл из папки Mestia".into());
    }
    let device = crate::storage::setting(&app, "transcriptionDevice").unwrap_or_default();
    let gpu = device == "gpu" || (device != "cpu" && detect().vram.is_some());
    let cpu_engine = if device == "gpu" {
        None
    } else {
        Some(ensure_engine(&app, false, &updates).await?)
    };
    let gpu_engine = if gpu {
        match ensure_engine(&app, true, &updates).await {
            Ok(path) => Some(path),
            Err(error) if device != "gpu" => {
                let _ = updates.send(Update::Log(error));
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let (name, checksum) = MODELS
        .iter()
        .copied()
        .find(|(name, _)| *name == model)
        .ok_or("Неизвестная модель")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("transcription-models");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let model_path = dir.join(format!("ggml-{name}.bin"));
    if !model_path.is_file() {
        let temp = tempfile::NamedTempFile::new_in(&dir)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        let mut file = tokio::fs::File::create(&temp)
            .await
            .map_err(|e| e.to_string())?;
        let mut response = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(60))
            .build().map_err(|e| e.to_string())?
            .get(format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/87cd18b47b941d2f65d09981dad23bb7d0481c77/ggml-{name}.bin"))
            .send().await.and_then(reqwest::Response::error_for_status).map_err(|e| e.to_string())?;
        let mut hash = Sha1::new();
        let mut bytes = 0;
        let _ = updates.send(Update::Download(0));
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            hash.update(&chunk);
            bytes += chunk.len() as u64;
            let _ = updates.send(Update::Download(bytes));
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        if format!("{:x}", hash.finalize()) != checksum {
            return Err("Контрольная сумма модели не совпала".into());
        }
        temp.persist(&model_path).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let wav = dir.path().join("input.wav");
        let output = dir.path().join("transcript");
        let _ = updates.send(Update::Prepare);
        let mut cmd = command(&ffmpeg);
        cmd.args([
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-progress",
            "pipe:1",
            "-i",
        ])
        .arg(input)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&wav);
        run(cmd, &updates)?;
        let _ = updates.send(Update::Recognize);
        let recognize = |engine: &Path, cpu: bool| {
            let mut cmd = command(engine);
            cmd.arg("-m")
                .arg(&model_path)
                .arg("-f")
                .arg(&wav)
                .args([
                    "-l",
                    &language,
                    "-pp",
                    if options.timestamps { "-osrt" } else { "-otxt" },
                    "-of",
                ])
                .arg(&output);
            if options.translate {
                cmd.arg("-tr");
            }
            if cpu {
                cmd.arg("-ng");
            }
            run(cmd, &updates)
        };
        if let Some(engine) = gpu_engine {
            match recognize(&engine, false) {
                Ok(used_cuda) if used_cuda || device != "gpu" => {
                    if !used_cuda {
                        let _ = updates.send(Update::CpuFallback);
                    }
                    return std::fs::read_to_string(
                        output.with_extension(options.output_extension()),
                    )
                    .map_err(|e| e.to_string());
                }
                Ok(false) if device == "gpu" => {
                    return Err("whisper.cpp не смог запустить CUDA".into())
                }
                Err(error) if device == "gpu" => return Err(error),
                _ => {
                    let _ = updates.send(Update::CpuFallback);
                }
            }
        }
        recognize(&cpu_engine.ok_or("Не найден движок CPU")?, true)?;
        std::fs::read_to_string(output.with_extension(options.output_extension()))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn export_content(transcript: &str, format: &str, timestamps: bool) -> String {
    if format != "md" || !timestamps {
        return transcript.to_owned();
    }
    // Подбираем ограду длиннее любой последовательности обратных кавычек в тексте.
    let longest = transcript
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!(
        "{fence}srt\n{}{fence}\n",
        if transcript.ends_with('\n') {
            transcript.to_owned()
        } else {
            format!("{transcript}\n")
        }
    )
}

#[tauri::command(async)]
pub fn save_transcript(
    app: AppHandle,
    transcript: String,
    title: String,
    format: String,
    timestamps: bool,
) -> Result<bool, String> {
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    let label = match format.as_str() {
        "txt" => "TXT",
        "md" => "Markdown",
        _ => return Err("Неизвестный формат экспорта".into()),
    };
    let filename = title
        .chars()
        .take(80)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let filename = filename.trim_matches([' ', '.']);
    let filename = if filename.is_empty() {
        "transcript"
    } else {
        filename
    };
    let Some(path) = app
        .dialog()
        .file()
        .add_filter(label, &[&format])
        .set_file_name(format!("{filename}.{format}"))
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .ok_or("Не удалось определить папку экспорта")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(export_content(&transcript, &format, timestamps).as_bytes())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_preserves_unicode_and_plain_text() {
        let text = "Привет\n你好\n";
        for format in ["txt", "md"] {
            assert_eq!(export_content(text, format, false), text);
        }
    }

    #[test]
    fn txt_preserves_timed_output_verbatim() {
        let srt = "1\n00:00:00,000 --> 00:00:01,000\nПривет";
        assert_eq!(export_content(srt, "txt", true), srt);
    }

    #[test]
    fn markdown_preserves_subtitle_line_breaks() {
        assert_eq!(
            export_content("1\nПривет\n", "md", true),
            "```srt\n1\nПривет\n```\n"
        );
        assert_eq!(export_content("```", "md", true), "````srt\n```\n````\n");
    }

    #[test]
    fn accepts_supported_explicit_languages_with_translation_and_timestamps() {
        let options: TranscriptionOptions =
            serde_json::from_str(r#"{"language":"zh","translate":true,"timestamps":true}"#)
                .unwrap();
        assert_eq!(options.language_for("large-v3-q5_0").unwrap(), "zh");
        assert_eq!(options.output_extension(), "srt");
    }

    #[test]
    fn old_callers_keep_auto_language_and_plain_text() {
        let options: TranscriptionOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(options.language_for("small").unwrap(), "auto");
        assert_eq!(options.output_extension(), "txt");
    }

    #[test]
    fn english_models_override_saved_language() {
        let options = TranscriptionOptions {
            language: Some("ru".into()),
            ..Default::default()
        };
        assert_eq!(options.language_for("small.en").unwrap(), "en");
    }

    #[test]
    fn translation_rejects_turbo_and_english_models() {
        let options = TranscriptionOptions {
            translate: true,
            ..Default::default()
        };
        for model in ["large-v3-turbo", "large-v3-turbo-q5_0", "base.en"] {
            assert!(options.language_for(model).is_err());
        }
        assert_eq!(options.language_for("medium").unwrap(), "auto");
    }

    #[test]
    fn validates_language_and_selects_timestamped_output() {
        let options = TranscriptionOptions {
            language: Some("invalid".into()),
            timestamps: true,
            ..Default::default()
        };
        assert!(options.language_for("small").is_err());
        assert_eq!(options.output_extension(), "srt");
    }
}
