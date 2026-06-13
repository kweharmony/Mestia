import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DonePayload,
  DownloadFormat,
  FetchResult,
  ItemPayload,
  ProgressPayload,
} from "../types";

// ── Команды Rust ──────────────────────────────────────────────────────────────

/** Получить метаданные по ссылке (видео или плейлист). */
export function fetchMetadata(url: string): Promise<FetchResult> {
  return invoke<FetchResult>("fetch_metadata", { url });
}

/**
 * Запустить скачивание. Прогресс приходит событиями `download://progress`,
 * каждое готовое видео — `download://item`, завершение — `download://done`.
 */
export function startDownload(args: {
  id: string;
  url: string;
  format: string;
  isAudio: boolean;
  audioFormat: string | null;
  mode: "single" | "all" | "range";
  items: string | null;
  outDir: string | null;
  recovery?: "resume" | "restart" | null;
}): Promise<void> {
  return invoke("start_download", { args });
}

/** Создать папку на диске (parentPath — путь родительской папки или null для корня). */
export function createFolderOnDisk(name: string, parentPath: string | null): Promise<string> {
  return invoke<string>("create_folder_dir", { name, parent: parentPath });
}

/** Физически переместить файл видео в папку (по абсолютному пути) и вернуть новый путь. */
export function moveVideoFile(filePath: string, destDir: string): Promise<string> {
  return invoke<string>("move_video_file", { filePath, destDir });
}

/** Открыть папку в системном проводнике. */
export function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}

/** Удалить файл с диска. */
export function deleteFileOnDisk(path: string): Promise<void> {
  return invoke("delete_file", { path });
}

/** Удалить папку со всем содержимым с диска. */
export function deleteFolderOnDisk(path: string): Promise<void> {
  return invoke("delete_folder", { path });
}

/** Переименовать папку на диске. Возвращает новый путь. */
export function renameFolderOnDisk(oldPath: string, newName: string): Promise<string> {
  return invoke<string>("rename_folder", { oldPath, newName });
}

/** Открыть содержащую файл папку в системном проводнике. */
export function revealInExplorer(filePath: string): Promise<void> {
  return invoke("reveal_in_explorer", { filePath });
}

/** Корневая папка хранилища (настраиваемая, по умолчанию Документы/Mestia). */
export function getStorageRoot(): Promise<string> {
  return invoke<string>("get_storage_root");
}

/** Задать папку загрузок. Возвращает применённый путь. */
export function setStorageRoot(path: string): Promise<string> {
  return invoke<string>("set_storage_root", { path });
}

/** Отменить активную загрузку (процесс убивается, .part остаётся для resume). */
export function cancelDownload(id: string): Promise<void> {
  return invoke("cancel_download", { id });
}

/** Самообновление yt-dlp. Возвращает итоговую строку вывода. */
export function updateYtdlp(): Promise<string> {
  return invoke<string>("update_ytdlp");
}

/** Сгенерировать превью-кадр видео (кэшируется). Возвращает путь к jpg. */
export function generateThumbnail(videoPath: string): Promise<string> {
  return invoke<string>("generate_thumbnail", { videoPath });
}

/** Начать слежение за папкой библиотеки (события `library://changed`). */
export function watchLibrary(path: string): Promise<void> {
  return invoke("watch_library", { path });
}

/** Проверить существование путей (параллельно). */
export function existingPaths(paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("existing_paths", { paths });
}

/** Подписка на изменения в папке библиотеки. */
export function onLibraryChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("library://changed", () => cb());
}

/** Полностью выйти из приложения. */
export function exitApp(): Promise<void> {
  return invoke("exit_app");
}

/** Удаляет приложение: данные (+опц. скачанный контент) и запуск деинсталляции ОС. */
export function uninstallApp(deleteContent: boolean): Promise<void> {
  return invoke("uninstall_app", { deleteContent });
}

/** Прочитать строковую настройку (или null). */
export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/** Сохранить строковую настройку. */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

/** Медиафайл, найденный сканированием папки. */
export interface MediaFile {
  path: string;
  name: string;
  size: number;
}

/** Найти медиафайлы (видео/аудио), лежащие прямо в папке dir. */
export function scanMedia(dir: string): Promise<MediaFile[]> {
  return invoke<MediaFile[]>("scan_media", { dir });
}

/** Подпапка, найденная сканированием. */
export interface DirEntry {
  path: string;
  name: string;
}

/** Найти непосредственные подпапки папки dir. */
export function scanDirs(dir: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("scan_dirs", { dir });
}

// ── Подписки на события прогресса ─────────────────────────────────────────────

export function onProgress(
  cb: (p: ProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("download://progress", (e) => cb(e.payload));
}

export function onItem(cb: (p: ItemPayload) => void): Promise<UnlistenFn> {
  return listen<ItemPayload>("download://item", (e) => cb(e.payload));
}

export function onDone(cb: (p: DonePayload) => void): Promise<UnlistenFn> {
  return listen<DonePayload>("download://done", (e) => cb(e.payload));
}

// ── Каталог форматов скачивания ────────────────────────────────────────────────

export const VIDEO_FORMATS: DownloadFormat[] = [
  {
    id: "v1080",
    label: "1080p · MP4",
    format:
      "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[height<=1080]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v720",
    label: "720p · MP4",
    format:
      "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v480",
    label: "480p · MP4",
    format:
      "bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/best[height<=480]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "vbest",
    label: "Лучшее качество",
    format: "bestvideo+bestaudio/best",
    ext: "mp4",
    isAudio: false,
  },
];

export const AUDIO_FORMATS: DownloadFormat[] = [
  { id: "mp3_320", label: "MP3 · 320 kbps", format: "bestaudio/best", ext: "mp3_320", isAudio: true },
  { id: "mp3_128", label: "MP3 · 128 kbps", format: "bestaudio/best", ext: "mp3_128", isAudio: true },
  { id: "wav", label: "WAV · без потерь", format: "bestaudio/best", ext: "wav", isAudio: true },
];

// ── Утилиты форматирования ─────────────────────────────────────────────────────

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

const AUDIO_EXTS = ["mp3", "m4a", "wav", "flac", "opus", "aac", "ogg", "oga"];

/** Является ли файл аудио (по расширению пути). */
export function isAudioPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}
