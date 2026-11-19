use std::path::PathBuf;

/// Очистка имени папки от недопустимых для файловой системы символов.
pub(crate) fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    cleaned.trim().to_string()
}

/// Свободный путь: сам `p`, если он не занят, иначе `stem (2).ext`, `stem (3).ext`…
pub(crate) fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = p.parent().map(PathBuf::from).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(p)
}
