import Database from "@tauri-apps/plugin-sql";
import type { FolderRow, HistoryRow, HistoryStatus, VideoRow } from "../types";

// Имя БД должно совпадать с тем, что регистрируется в Rust (lib.rs).
const DB_URL = "sqlite:mestia.db";

let _db: Database | null = null;

export async function db(): Promise<Database> {
  if (!_db) _db = await Database.load(DB_URL);
  return _db;
}

// ── Папки ──────────────────────────────────────────────────────────────────────

export async function listFolders(parentId: number | null = null): Promise<FolderRow[]> {
  const d = await db();
  if (parentId === null) {
    return d.select<FolderRow[]>(
      "SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE"
    );
  }
  return d.select<FolderRow[]>(
    "SELECT * FROM folders WHERE parent_id = $1 ORDER BY name COLLATE NOCASE",
    [parentId]
  );
}

/**
 * Удаляет из БД все папки и видео, чьи пути лежат вне текущего корня
 * хранилища (остатки от ранее выбранной основной папки). Файлы на диске
 * не трогаются — чистим только записи библиотеки.
 */
export async function pruneOutsideRoot(root: string): Promise<void> {
  if (!root) return;
  const d = await db();
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const prefix = norm(root) + "/";
  const folders = await d.select<{ id: number; path: string }[]>("SELECT id, path FROM folders");
  for (const f of folders) {
    if (!norm(f.path).startsWith(prefix)) {
      await d.execute("DELETE FROM folders WHERE id = $1", [f.id]);
    }
  }
  const videos = await d.select<{ id: number; file_path: string }[]>(
    "SELECT id, file_path FROM videos"
  );
  for (const v of videos) {
    if (!norm(v.file_path).startsWith(prefix)) {
      await d.execute("DELETE FROM videos WHERE id = $1", [v.id]);
    }
  }
}

/** Все пути папок, уже занесённых в БД (для дедупликации при сканировании). */
export async function allFolderPaths(): Promise<Set<string>> {
  const d = await db();
  const rows = await d.select<{ path: string }[]>("SELECT path FROM folders");
  return new Set(rows.map((r) => r.path));
}

export async function createFolder(
  name: string,
  path: string,
  parentId: number | null = null
): Promise<number> {
  const d = await db();
  const res = await d.execute(
    "INSERT INTO folders (name, parent_id, path) VALUES ($1, $2, $3)",
    [name, parentId, path]
  );
  return res.lastInsertId ?? 0;
}

// ── Видео ────────────────────────────────────────────────────────────────────

export async function listVideos(folderId: number | null = null): Promise<VideoRow[]> {
  const d = await db();
  if (folderId === null) {
    return d.select<VideoRow[]>(
      "SELECT * FROM videos WHERE folder_id IS NULL ORDER BY created_at DESC"
    );
  }
  return d.select<VideoRow[]>(
    "SELECT * FROM videos WHERE folder_id = $1 ORDER BY created_at DESC",
    [folderId]
  );
}

export async function insertVideo(v: {
  title: string;
  url: string | null;
  file_path: string;
  duration: number | null;
  size: number | null;
  thumbnail_path: string | null;
  platform: string | null;
  folder_id?: number | null;
}): Promise<void> {
  const d = await db();
  // Upsert по пути файла: если запись с таким file_path уже есть (повторное
  // скачивание/пере-скан) — обновляем её, а не плодим дубликат. Обложку
  // сохраняем прежнюю (вдруг пользователь поставил свою).
  const existing = await d.select<{ id: number }[]>(
    "SELECT id FROM videos WHERE file_path = $1 LIMIT 1",
    [v.file_path]
  );
  if (existing[0]) {
    await d.execute(
      `UPDATE videos
         SET title = $1, url = $2, duration = $3, size = $4,
             thumbnail_path = COALESCE(thumbnail_path, $5), platform = $6, folder_id = $7
       WHERE id = $8`,
      [v.title, v.url, v.duration, v.size, v.thumbnail_path, v.platform, v.folder_id ?? null, existing[0].id]
    );
    return;
  }
  await d.execute(
    `INSERT INTO videos (title, url, file_path, duration, size, thumbnail_path, platform, folder_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      v.title,
      v.url,
      v.file_path,
      v.duration,
      v.size,
      v.thumbnail_path,
      v.platform,
      v.folder_id ?? null,
    ]
  );
}

/** Все пути файлов, уже занесённых в БД (для дедупликации при сканировании). */
export async function allVideoPaths(): Promise<Set<string>> {
  const d = await db();
  const rows = await d.select<{ file_path: string }[]>("SELECT file_path FROM videos");
  return new Set(rows.map((r) => r.file_path));
}

export async function getVideoById(id: number): Promise<VideoRow | null> {
  const d = await db();
  const rows = await d.select<VideoRow[]>("SELECT * FROM videos WHERE id = $1 LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function findVideoByUrl(url: string): Promise<VideoRow | null> {
  const d = await db();
  const rows = await d.select<VideoRow[]>(
    "SELECT * FROM videos WHERE url = $1 ORDER BY created_at DESC LIMIT 1",
    [url]
  );
  return rows[0] ?? null;
}

export async function moveVideoToFolder(
  videoId: number,
  folderId: number | null,
  newPath: string
): Promise<void> {
  const d = await db();
  await d.execute("UPDATE videos SET folder_id = $1, file_path = $2 WHERE id = $3", [
    folderId,
    newPath,
    videoId,
  ]);
}

export async function searchVideos(query: string): Promise<VideoRow[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const d = await db();
  // Фильтруем в JS: toLowerCase() корректно сворачивает регистр Unicode/кириллицы,
  // а SQL LIKE/lower() в SQLite регистронезависим только для латиницы.
  const all = await d.select<VideoRow[]>(
    "SELECT * FROM videos ORDER BY created_at DESC LIMIT 2000"
  );
  return all.filter(
    (v) =>
      (v.title ?? "").toLowerCase().includes(q) ||
      (v.platform ?? "").toLowerCase().includes(q)
  );
}

export async function updateVideoThumb(id: number, path: string): Promise<void> {
  const d = await db();
  await d.execute("UPDATE videos SET thumbnail_path = $1 WHERE id = $2", [path, id]);
}

export async function renameVideo(id: number, title: string): Promise<void> {
  const d = await db();
  await d.execute("UPDATE videos SET title = $1 WHERE id = $2", [title, id]);
}

export async function deleteVideoRow(id: number): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM videos WHERE id = $1", [id]);
}

/** Рекурсивно удаляет из БД папку, её подпапки и все видео внутри. */
export async function deleteFolderTree(folderId: number): Promise<void> {
  const d = await db();
  const subs = await listFolders(folderId);
  for (const s of subs) await deleteFolderTree(s.id);
  await d.execute("DELETE FROM videos WHERE folder_id = $1", [folderId]);
  await d.execute("DELETE FROM folders WHERE id = $1", [folderId]);
}

/**
 * Переименовывает папку в БД и каскадно правит пути всех вложенных
 * видео и подпапок (prefix oldPath → newPath, без LIKE-джокеров).
 */
export async function renameFolderRows(
  id: number,
  oldPath: string,
  newPath: string,
  newName: string
): Promise<void> {
  const d = await db();
  const n = oldPath.length;
  // Вложенные видео.
  await d.execute(
    "UPDATE videos SET file_path = $1 || substr(file_path, $2) WHERE substr(file_path, 1, $3) = $4",
    [newPath, n + 1, n, oldPath]
  );
  // Вложенные подпапки (исключая саму папку).
  await d.execute(
    "UPDATE folders SET path = $1 || substr(path, $2) WHERE substr(path, 1, $3) = $4 AND id != $5",
    [newPath, n + 1, n, oldPath, id]
  );
  // Сама папка.
  await d.execute("UPDATE folders SET name = $1, path = $2 WHERE id = $3", [
    newName,
    newPath,
    id,
  ]);
}

// ── История ─────────────────────────────────────────────────────────────────

export async function listHistory(): Promise<HistoryRow[]> {
  const d = await db();
  return d.select<HistoryRow[]>("SELECT * FROM history ORDER BY timestamp DESC LIMIT 200");
}

export async function insertHistory(h: {
  title: string | null;
  url: string;
  status: HistoryStatus;
  file_size: number | null;
  platform: string | null;
  format?: string | null;
  is_audio?: boolean;
  audio_format?: string | null;
  mode?: string | null;
  items?: string | null;
  out_dir?: string | null;
}): Promise<number> {
  const d = await db();
  const res = await d.execute(
    `INSERT INTO history (title, url, status, file_size, platform, format, is_audio, audio_format, mode, items, out_dir)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      h.title,
      h.url,
      h.status,
      h.file_size,
      h.platform,
      h.format ?? null,
      h.is_audio ? 1 : 0,
      h.audio_format ?? null,
      h.mode ?? null,
      h.items ?? null,
      h.out_dir ?? null,
    ]
  );
  return res.lastInsertId ?? 0;
}

/** Помечает зависшие «downloading» как «interrupted» (вызывается при старте). */
export async function markInterrupted(): Promise<void> {
  const d = await db();
  await d.execute("UPDATE history SET status = 'interrupted' WHERE status = 'downloading'");
}

/** Находит id папки по её пути (для возобновления загрузки плейлиста). */
export async function findFolderByPath(path: string): Promise<number | null> {
  const d = await db();
  const rows = await d.select<{ id: number }[]>(
    "SELECT id FROM folders WHERE path = $1 LIMIT 1",
    [path]
  );
  return rows[0]?.id ?? null;
}

export async function updateHistoryStatus(
  id: number,
  status: HistoryStatus,
  fileSize: number | null
): Promise<void> {
  const d = await db();
  await d.execute("UPDATE history SET status = $1, file_size = $2 WHERE id = $3", [
    status,
    fileSize,
    id,
  ]);
}

export async function clearHistory(): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM history");
}

export async function deleteHistoryRow(id: number): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM history WHERE id = $1", [id]);
}
