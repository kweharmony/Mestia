# Mestia — Semantic Context Map (CCS)

Cross-platform app (Tauri v2: Windows/macOS/Linux/Steam Deck + Android) for downloading
video/audio via `yt-dlp` and managing a local media library, with a built-in player.

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
  - `LanguageContext` — i18n (ru/en/zh); exposes `useI18n().t`, persists setting `lang`,
    defaults to OS locale on first run.
  - `DownloadsContext` — download queue, concurrency limit, live progress events.
  - `DragContext` — drag-and-drop state for the library.
  - `LanContext` — LAN: visibility (setting `lanVisible`), discovered peers, transfers,
    incoming-offer modal, current watch-together room.
- `components/` — reusable UI: `Sidebar`, `Settings`, `DownloadsPanel`, `Splash`,
  `Toast`, `Typewriter`, `ThemeSwitcher`, `Logo`, `LibraryPicker` (library + storage-root
  files for LAN send and the room queue).
- `lib/`:
  - `ipc.ts` — typed wrappers over Tauri `invoke` (the single bridge to Rust).
  - `db.ts` — SQLite access (history, library structure, metadata).
  - `i18n.ts` — trilingual dictionary (`ru`/`en`/`zh`) + `t()`; module-level `t()` for
    non-React code (e.g. `humanizeError`, desktop notifications).
  - `platform.ts` — `IS_ANDROID` (hides tray, explorer, mini-window, cookies, uninstall)
  - `appIcon.ts` — logo marks (`LOGO_MARK`) + `applyThemeIcon()`: favicon/window/tray icon in the theme accent (called from ThemeContext); concept sources in `design/logo/`
    and URL extraction from shared text.
  - `roomSync.ts` — watch-together drift correction (seek on big drift, ±6% rate on small).
- `views/` — top-level screens:
  - `Downloader` — paste URL, pick format/quality, start downloads.
  - `Locker` — the media library (folders + videos grid, multi-select, drag-drop).
  - `History` — past downloads with statuses; resume interrupted (`.part`) downloads.
  - `Player` / `MiniPlayer` — main and floating video/audio players; playback position
    persisted per file.
  - `Nearby` — LAN devices: visibility toggle, send files, manual add by address, rooms.
  - `Room` — watch-together player with a queue (host adds/reorders, auto-advance;
    guests suggest their own files).
- `types.ts` — shared TypeScript types.

### `src-tauri/` — Backend
- `src/main.rs` — thin entry, calls `mestia_lib::run()`.
- `src/lib.rs` — registers plugins, builds the tray, smart-close behavior, and exposes
  the Tauri commands the frontend calls.
- `src/downloader.rs` — builds `yt-dlp` arguments (metadata, download), parses and
  emits progress/item/done events.
- `src/engine.rs` — runs `yt-dlp` and streams its output line by line: desktop → sidecar
  via tauri-plugin-shell; Android → Kotlin plugin. Owns cancel (incl. cancel before start).
- `src/mobile.rs` — Android bridge to `MestiaPlugin` (Kotlin): storage root, thumbnails
  (MediaMetadataRetriever), open file (FileProvider), MediaStore scan, share intent,
  move-to-back, yt-dlp update.
- `gen/android/` — Android Studio project. `MestiaPlugin.kt` wraps youtubedl-android
  (Python + yt-dlp + ffmpeg); `DownloadService.kt` — foreground service while downloads
  run; `MainActivity.kt` — system-bar insets; manifest — `ACTION_SEND text/plain` share
  target, `extractNativeLibs`.
- `src/storage.rs` — filesystem ops: files/folders, real-time file-watcher, thumbnail
  generation (ffmpeg, cached), settings.
- `src/lan.rs` — LAN: UDP announces (multicast 239.255.77.18 + subnet broadcast, port
  53318), axum HTTP/WS server on TCP 53318 (`/api/info`, `/api/offer`, `/api/upload`,
  `/api/room`, `/api/room/media` with Range, `/api/room/ws`), sender via reqwest,
  watch-together guest via tokio-tungstenite with NTP-like clock offset.
- `migrations/0001_init.sql` — SQLite schema (applied automatically).
- `capabilities/default.json` — Tauri plugin permissions; `desktop.json` — desktop-only
  (updater). `tauri.android.conf.json` drops sidecars and sets minSdk 30.
- `tauri.conf.json` — window, tray, sidecar registration, asset protocol, NSIS
  installer, and GitHub-Releases auto-updater config.

## Key flows
- **LAN share**: sender `lan_send` → POST `/api/offer` → receiver shows modal (90 s) →
  `lan_answer_offer` → session → PUT `/api/upload` per file into the storage root
  (`.name.mestia-part` → rename) → `lan://received`.
- **Watch together**: host `lan_room_start` (room title in announces) and pushes player
  state via `lan_room_state`; guest `lan_room_join` streams `/api/room/media`, gets
  `lan://room-state` (time already in local clock) and corrects drift (`roomSync.ts`);
  guest controls send `lan_room_cmd` to the host. Queue: host owns it (`lan_room_add/move/
  remove/play`), broadcasts `{t:"queue"}`; on `ended` the host plays the next item. A guest
  `lan_room_propose` registers a token in its own `/api/share/media` and the item streams
  from the guest's device; its items drop when the guest leaves. Android: `MulticastLock`
  (`lanMulticast`), cleartext HTTP allowed for LAN media.

- **Download**: `Downloader` view → `ipc.ts` → `downloader.rs` (builds args) →
  `engine.rs` (sidecar on desktop / `MestiaPlugin.execute` on Android) → progress events →
  `DownloadsContext` → UI. On Android a foreground service keeps the process alive and each
  finished file is registered in MediaStore; links arrive via «Share → Mestia». Records land in SQLite via `db.ts`.
  `downloader.rs` reads opt-in settings (`storage::setting`) for browser cookies,
  subtitles and SponsorBlock, and always embeds metadata/thumbnail.
- **Library**: files live in the user's downloads folder (Android: `Download/Mestia` by
  default; changeable via `MestiaPlugin.pickFolder` — SAF tree → filesystem path, asks for
  "All files access" outside `Download/`; `set_storage_root(migrate)` moves the old folder's
  contents and the frontend rebases DB paths with `db.rebaseRoot`);
  `storage.rs` watches the folder (desktop) and emits change events so the `Locker` grid
  stays in sync; on Android the grid rescans on focus. Thumbnails are
  generated on demand and cached in the app data dir.
- **Auto-update**: on launch the updater plugin checks GitHub Releases; if newer, a
  modal offers to download, install, and relaunch. Not on Android (APK from Releases);
  yt-dlp itself updates via Settings on every platform.
- **Release**: tag `v*` → `.github/workflows/release.yml`: `build` (tauri-action, draft
  release + `latest.json`), `android` (signed per-ABI APKs from `ANDROID_KEYSTORE_*`
  secrets), `release-notes` (body from `.github/release-notes.md`), `rename-mac-updater`.

## Conventions
- Code comments are in **Russian**. UI strings are **localized via i18n** (`src/lib/i18n.ts`,
  `useI18n().t`) in ru/en/zh — never hardcode user-facing text. Rust backend messages stay
  Russian; `humanizeError` translates the common ones.
- Versions in `package.json` and `src-tauri/tauri.conf.json` must stay in sync.
- Tests: Vitest (`npm test`, frontend pure logic) and `cargo test` (Rust). No linter; type safety via `tsc --noEmit`.
