// ── Доменные типы Mestia ──────────────────────────────────────────────────────

export type ThemeName =
  | "lavender"
  | "midnight"
  | "matcha"
  | "mono"
  | "ember"
  | "indigo"
  | "forest"
  | "graphite";

export type TabId = "downloader" | "locker" | "history";

/** Результат получения метаданных: одиночное видео или плейлист. */
export interface FetchResult {
  is_playlist: boolean;
  title: string;
  uploader: string | null;
  duration: number | null; // секунды (для видео)
  thumbnail: string | null; // URL превью
  platform: string | null; // extractor_key
  webpage_url: string | null;
  playlist_count: number | null; // кол-во видео (для плейлиста)
  sizes: FormatSizes | null; // прикидка размеров по пресетам (только одиночное видео)
  resolved_url: string | null; // точная ссылка для загрузки (Spotify/Apple/поиск); иначе null
}

/** Прикидка размера (байты) по пресетам качества видео. */
export interface FormatSizes {
  v2160: number | null;
  v1440: number | null;
  v1080: number | null;
  v720: number | null;
  v480: number | null;
  vbest: number | null;
  max_height: number | null; // макс. высота дорожки в источнике (для показа 2K/4K)
}

/** Вариант формата для скачивания. */
export interface DownloadFormat {
  id: string;
  label: string;
  /** Строка -f для yt-dlp. */
  format: string;
  /** Целевое расширение/режим (mp4, mp3_320, wav…). */
  ext: string;
  isAudio: boolean;
  /** Мин. высота источника, при которой пресет показывается (для 2K/4K). */
  minHeight?: number;
}

/** Событие прогресса, прилетающее из Rust по каналу `download://progress`. */
export interface ProgressPayload {
  id: string;
  downloaded: number | null;
  total: number | null;
  speed: number | null; // байт/с
  eta: number | null; // секунды
  percent: number; // 0..100
  index: number | null; // номер видео в плейлисте
  total_items: number | null; // всего видео
}

/** Событие готового видео `download://item` — добавляется в БД. */
export interface ItemPayload {
  id: string;
  title: string;
  filePath: string;
  url: string | null;
  duration: number | null;
  thumbnail: string | null;
  platform: string | null;
  size: number | null; // размер готового файла на диске, байты
}

/** Финальное событие `download://done`. */
export interface DonePayload {
  id: string;
  count: number; // сколько видео скачано
  ok: boolean;
  error: string | null;
}

// ── Строки таблиц SQLite ──────────────────────────────────────────────────────

export interface FolderRow {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  created_at: string;
}

export interface VideoRow {
  id: number;
  title: string;
  url: string | null;
  file_path: string;
  duration: number | null;
  size: number | null;
  folder_id: number | null;
  thumbnail_path: string | null;
  platform: string | null;
  created_at: string;
}

export type HistoryStatus = "success" | "downloading" | "error" | "interrupted";

export interface HistoryRow {
  id: number;
  title: string | null;
  url: string;
  status: HistoryStatus;
  timestamp: string;
  file_size: number | null;
  platform: string | null;
  // Параметры исходной загрузки — для продолжения/перезапуска.
  format: string | null;
  is_audio: number | null;
  audio_format: string | null;
  mode: string | null;
  items: string | null;
  out_dir: string | null;
}
