import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "./i18n";
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

/** Открыть файл во внешнем приложении по умолчанию (запасной плеер). */
export function openPath(path: string): Promise<void> {
  return invoke("open_path", { path });
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

/** Внешние субтитры рядом с видео в формате WebVTT (или null). */
export function subtitleTrack(videoPath: string): Promise<string | null> {
  return invoke<string | null>("subtitle_track", { videoPath });
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

/** Поддерживает ли сборка самообновление (Win/macOS — да, Linux — только AppImage). */
export function updaterSupported(): Promise<boolean> {
  return invoke<boolean>("updater_supported");
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
    id: "v2160",
    label: "4K · MP4",
    // 4K обычно только VP9/AV1 (avc1 почти не бывает) — пробуем avc1, иначе любой кодек.
    minHeight: 1700, // показываем, только если в источнике есть дорожка ~2160p
    format:
      "bestvideo[vcodec^=avc1][height<=2160]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v1440",
    label: "1440p · 2K",
    minHeight: 1200, // показываем, только если есть дорожка ~1440p
    format:
      "bestvideo[vcodec^=avc1][height<=1440]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v1080",
    label: "1080p · MP4",
    minHeight: 900,
    // Предпочитаем H.264/AAC: только такой mp4 гарантированно играется в Windows.
    format:
      "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[height<=1080]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v720",
    label: "720p · MP4",
    minHeight: 600,
    format:
      "bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "v480",
    label: "480p · MP4",
    minHeight: 400,
    format:
      "bestvideo[vcodec^=avc1][height<=480]+bestaudio[ext=m4a]/bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/best[height<=480]",
    ext: "mp4",
    isAudio: false,
  },
  {
    id: "vbest",
    label: "Лучшее качество",
    // Сначала H.264/AAC (совместимо везде), и только если их нет — любое лучшее.
    format:
      "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
    ext: "mp4",
    isAudio: false,
  },
];

// Дефолтный видеопресет — 1080p (есть почти всегда), а не 4K из начала списка.
export const DEFAULT_VIDEO_FORMAT: DownloadFormat =
  VIDEO_FORMATS.find((f) => f.id === "v1080") ?? VIDEO_FORMATS[0];

export const AUDIO_FORMATS: DownloadFormat[] = [
  { id: "mp3_320", label: "MP3 · 320 kbps", format: "bestaudio/best", ext: "mp3_320", isAudio: true },
  { id: "mp3_128", label: "MP3 · 128 kbps", format: "bestaudio/best", ext: "mp3_128", isAudio: true },
  // Предпочитаем готовую m4a-дорожку — тогда yt-dlp копирует AAC без перекодирования.
  { id: "m4a", label: "M4A · AAC", format: "bestaudio[ext=m4a]/bestaudio/best", ext: "m4a", isAudio: true },
  { id: "opus", label: "OPUS", format: "bestaudio/best", ext: "opus", isAudio: true },
  { id: "ogg", label: "OGG · Vorbis", format: "bestaudio/best", ext: "ogg", isAudio: true },
  { id: "flac", label: "FLAC · без потерь", format: "bestaudio/best", ext: "flac", isAudio: true },
  { id: "wav", label: "WAV · без потерь", format: "bestaudio/best", ext: "wav", isAudio: true },
  // Оригинальная дорожка как есть, без перекодирования (макс. качество и скорость).
  { id: "best", label: "Оригинал", format: "bestaudio/best", ext: "best", isAudio: true },
];

/** Локализованная подпись формата (часть подписей переводится, часть нейтральна). */
export function formatLabel(f: DownloadFormat): string {
  switch (f.id) {
    case "vbest":
      return t("fmt.best");
    case "best":
      return t("fmt.audioBest");
    case "flac":
      return `FLAC · ${t("fmt.lossless")}`;
    case "wav":
      return `WAV · ${t("fmt.lossless")}`;
    default:
      return f.label;
  }
}

// Битрейт результирующего аудио (бит/с) по пресету — размер считается из длительности.
// Для «Оригинал» битрейт неизвестен заранее → размер не показываем.
const AUDIO_BITRATE: Record<string, number> = {
  mp3_320: 320_000,
  mp3_128: 128_000,
  m4a: 192_000, // типичный AAC-битрейт исходной дорожки
  opus: 160_000, // ~битрейт opus на YouTube
  ogg: 160_000,
  flac: 900_000, // прикидка lossless-сжатия (≈60% от WAV)
  wav: 1_411_200, // 16 бит · 44.1 кГц · стерео
};

/** Оценка размера аудиофайла (байты) по длительности и пресету; null если не посчитать. */
export function estimateAudioBytes(
  durationSec: number | null | undefined,
  formatId: string
): number | null {
  const bitrate = AUDIO_BITRATE[formatId];
  if (!bitrate || !durationSec || durationSec <= 0) return null;
  return (bitrate / 8) * durationSec;
}

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

// Признаки того, что ошибка yt-dlp связана с доступом/входом — тогда часто
// помогает настройка «Куки из браузера» (приватное, 18+, по подписке, антибот).
const AUTH_ERROR_RE =
  /sign in|log ?in|cookies?|\bmembers?\b|join this channel|private video|this video is private|age[- ]?restrict|confirm your age|not a bot|music premium|requires (payment|purchase|a subscription)|subscriber|rental|this content isn|authenticat|--cookies/i;

/** Похоже ли сообщение об ошибке на проблему доступа, решаемую куками. */
export function isAuthError(msg: string | null | undefined): boolean {
  return !!msg && AUTH_ERROR_RE.test(msg);
}

/**
 * Превращает техническую ошибку (от Rust/yt-dlp/JS, часто английскую) в понятное
 * пользователю сообщение на русском. Наши собственные русские сообщения проходят
 * как есть; нераспознанное техническое — заменяется общим дружелюбным текстом.
 */
export function humanizeError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e ?? "")).trim();
  if (!raw) return t("err.generic");
  if (/^DRM:/i.test(raw)) return t("err.drm");
  const s = raw.toLowerCase();
  const has = (...subs: string[]) => subs.some((x) => s.includes(x));

  if (isAuthError(raw)) return t("err.auth");
  if (has("timed out", "timeout", "connection", "getaddrinfo", "temporary failure",
          "network is unreachable", "connection refused", "unable to download webpage",
          "failed to resolve", "name or service not known", "socket", "ssl", "winerror 100"))
    return t("err.network");
  if (has("no space left", "not enough space", "os error 112", "disk full", "enospc"))
    return t("err.disk");
  if (has("being used by another process", "os error 32", "resource busy", "sharing violation"))
    return t("err.busy");
  if (has("access is denied", "permission denied", "os error 5", "operation not permitted", "eacces"))
    return t("err.access");
  if (has("not found", "cannot find", "no such file", "os error 2", "os error 3", "enoent"))
    return t("err.notfound");
  if (has("video unavailable", "this video is unavailable", "has been removed", "has been deleted",
          "account has been terminated", "no longer available", "video does not exist"))
    return t("err.unavailable");
  if (has("not available in your country", "geo restrict", "geo-restricted", "in your country"))
    return t("err.geo");
  if (has("unsupported url", "is not a valid url", "unable to extract", "no video formats",
          "unable to download json metadata", "ничего не найдено"))
    return t("err.unsupported");

  // Сообщение бэкенда на русском (Rust отдаёт по-русски) — оставляем как есть.
  if (/[а-яё]/i.test(raw)) return raw;
  // Прочее техническое — общий понятный текст.
  return t("err.generic");
}

/** Тип провала загрузки — определяет действие (CTA), которое предложить пользователю. */
export type DownloadFailureKind =
  | "auth" // нужен вход — куки из браузера
  | "geo" // геоблок — предложить прокси
  | "drm" // защищённый (DRM) контент — скачать нельзя, действий нет
  | "unsupported" // сервис изменился/не распознан — обновить движок
  | "network" // сеть — можно повторить
  | "unavailable" // контент удалён/недоступен — действий нет
  | "unknown";

/**
 * Классифицирует ошибку загрузки в тип для CTA-кнопки. Переиспользует те же
 * сигнатуры, что и `humanizeError` (текст), но возвращает только категорию.
 */
export function classifyError(e: unknown): DownloadFailureKind {
  const raw = (e instanceof Error ? e.message : String(e ?? "")).trim();
  if (!raw) return "unknown";
  // Маркер жёсткого DRM из Rust (resolve_input) — финальная ошибка без действий.
  if (/^DRM:/i.test(raw)) return "drm";
  const s = raw.toLowerCase();
  const has = (...subs: string[]) => subs.some((x) => s.includes(x));

  if (isAuthError(raw)) return "auth";
  if (has("not available in your country", "geo restrict", "geo-restricted", "in your country"))
    return "geo";
  if (has("video unavailable", "this video is unavailable", "has been removed", "has been deleted",
          "account has been terminated", "no longer available", "video does not exist"))
    return "unavailable";
  if (has("unsupported url", "is not a valid url", "unable to extract", "no video formats",
          "unable to download json metadata"))
    return "unsupported";
  if (has("timed out", "timeout", "connection", "getaddrinfo", "temporary failure",
          "network is unreachable", "connection refused", "unable to download webpage",
          "failed to resolve", "name or service not known", "socket", "ssl", "winerror 100"))
    return "network";
  return "unknown";
}

const AUDIO_EXTS = ["mp3", "m4a", "wav", "flac", "opus", "aac", "ogg", "oga"];

/** Является ли файл аудио (по расширению пути). */
export function isAudioPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}
