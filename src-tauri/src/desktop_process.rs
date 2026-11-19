use std::{path::Path, process::Command};

pub(crate) fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(target_os = "android")]
    if let Some(libs) = std::env::var_os("MESTIA_ADDON_FFMPEG_LIBS") {
        command.env("LD_LIBRARY_PATH", libs);
    }
    command
}
