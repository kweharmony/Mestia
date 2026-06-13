# Mestia — Semantic Context Map (CCS)

Cross-platform desktop app (Tauri v2) for downloading video/audio via `yt-dlp` and
managing a local media library, with a built-in player.

## High-level shape

- **Frontend** (`src/`): React 18 + TypeScript + Vite + Tailwind v4, with `framer-motion`
  for layout/exit animations. Owns all UI. The root is wrapped in
  `<MotionConfig reducedMotion="user">` (`main.tsx`) to honor OS reduced-motion;
  motion-animated elements carry `.mestia-anim` so the global CSS transition (in
  `index.css`) doesn't conflict with framer's transform/opacity writes.
- **Backend** (`src-tauri/`): Rust + Tauri v2. Owns the filesystem, the `yt-dlp`/`ffmpeg`
  sidecars, SQLite, the system tray, and the auto-updater.
- **Bridge**: frontend invokes Rust commands through `src/lib/ipc.ts`; Rust pushes
  download-progress and file-watcher events back to the frontend.

## Directory purpose

### `flatpak/`
Flatpak packaging for Steam Deck / SteamOS (where there is no system WebKitGTK and the
root FS is read-only).
- `com.mestia.app.yml` — manifest. Uses the `org.gnome.Platform` runtime (which bundles
  WebKitGTK), extracts the `.deb` produced by `tauri build`, and installs the main binary
  + sidecars into `/app`.
- `com.mestia.app.desktop` / `com.mestia.app.metainfo.xml` — launcher entry and AppStream
  metadata (named by app-id, as Flatpak requires).
- Built in CI (`.github/workflows/release.yml`, Linux leg) and attached to the release as
  `Mestia.flatpak`. On Linux the app also sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` at startup
  (`src-tauri/src/lib.rs`) to avoid the AMD/WebKitGTK blank-window bug.

### `docs/`
GitHub Pages landing site — a single self-contained `index.html` (inline CSS/JS, Google
Fonts). Mirrors the app's 8 themes with a theme switcher, briefly describes the app, and
links to GitHub Releases for downloads. Static; unrelated to the app build. Publish via
repo Settings → Pages → "Deploy from a branch" → `main` / `/docs`.

### `scripts/`
Build-time Node helpers.
- `fetch-binaries.mjs` — downloads OS-specific `yt-dlp` + `ffmpeg`/`ffprobe` into
  `src-tauri/binaries/` (named with the target triple).
- `free-port.mjs` — frees dev port 1420 (runs as the `predev` hook).

### `src/` — Frontend
- `main.tsx` / `App.tsx` — entry point and root component / routing between views.
- `context/` — global React state:
  - `ThemeContext` — 8 themes, persisted.
  - `DownloadsContext` — download queue, concurrency limit, live progress events.
  - `DragContext` — drag-and-drop state for the library.
- `components/` — reusable UI: `Sidebar`, `Settings`, `DownloadsPanel`, `Splash`,
  `Toast`, `Typewriter`, `ThemeSwitcher`, `Logo`.
- `lib/`:
  - `ipc.ts` — typed wrappers over Tauri `invoke` (the single bridge to Rust).
  - `db.ts` — SQLite access (history, library structure, metadata).
- `views/` — top-level screens:
  - `Downloader` — paste URL, pick format/quality, start downloads.
  - `Locker` — the media library (folders + videos grid, multi-select, drag-drop).
  - `History` — past downloads with statuses; resume interrupted (`.part`) downloads.
  - `Player` / `MiniPlayer` — main and floating video/audio players; playback position
    persisted per file.
- `types.ts` — shared TypeScript types.

### `src-tauri/` — Backend
- `src/main.rs` — thin entry, calls `mestia_lib::run()`.
- `src/lib.rs` — registers plugins, builds the tray, smart-close behavior, and exposes
  the Tauri commands the frontend calls.
- `src/downloader.rs` — drives `yt-dlp`: fetch metadata, download, cancel, parse and
  emit progress.
- `src/storage.rs` — filesystem ops: files/folders, real-time file-watcher, thumbnail
  generation (ffmpeg, cached), settings.
- `migrations/0001_init.sql` — SQLite schema (applied automatically).
- `capabilities/default.json` — Tauri plugin permissions.
- `tauri.conf.json` — window, tray, sidecar registration, asset protocol, NSIS
  installer, and GitHub-Releases auto-updater config.

## Key flows

- **Download**: `Downloader` view → `ipc.ts` → `downloader.rs` (spawns `yt-dlp`) →
  progress events → `DownloadsContext` → UI. Records land in SQLite via `db.ts`.
- **Library**: files live in the user's downloads folder; `storage.rs` watches the
  folder and emits change events so the `Locker` grid stays in sync. Thumbnails are
  generated on demand and cached in the app data dir.
- **Auto-update**: on launch the updater plugin checks GitHub Releases; if newer, a
  modal offers to download, install, and relaunch.

## Conventions
- Code comments and UI strings are in **Russian**.
- Versions in `package.json` and `src-tauri/tauri.conf.json` must stay in sync.
- No test/lint setup; type safety is enforced by `tsc --noEmit`.
