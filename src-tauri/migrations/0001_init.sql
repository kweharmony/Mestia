-- Mestia — начальная схема БД (SQLite)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    path        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    url             TEXT,
    file_path       TEXT    NOT NULL,
    duration        INTEGER,
    size            INTEGER,
    folder_id       INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    thumbnail_path  TEXT,
    platform        TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    url         TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    file_size   INTEGER,
    platform    TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_history_time ON history(timestamp);
