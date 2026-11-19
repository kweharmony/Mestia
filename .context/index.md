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
GitHub Pages site, RU/EN (minimal, app-styled): `index.html` (hero with the promo video,
features, how-it-works animations, theme picker with app-icon tiles, download tabs with
direct links from the GitHub releases API, FAQ) and `privacy.html` (mirror of PRIVACY.md).
Shared `site.css` (the app's 8 themes 1:1) and `site.js` (theme + language persisted in
localStorage, `data-i18n` dictionaries per page, IntersectionObserver reveal; all motion off
under reduced-motion). `media/` holds the promo video. Publish via repo Settings → Pages →
"Deploy from a branch" → `main` / `/docs`.

### `design/promo/`
Promo video source: `promo.html` is a 1280×720 scene whose every frame is set by
`seek(t)` (no timers), `render.mjs` steps it at 30 fps in Playwright and encodes
`docs/media/promo[.en].mp4` + `.webp` (+ `poster.png`) with the ffmpeg sidecar.
`node design/promo/render.mjs [en|ru]` defaults to English and needs `playwright-core`, which is outside the project dependencies.

### `scripts/`
Build-time Node helpers.
- `fetch-binaries.mjs` — downloads OS-specific `yt-dlp` + `ffmpeg`/`ffprobe` into
  `src-tauri/binaries/` (named with the target triple).
- `free-port.mjs` — frees dev port 1420 (runs as the `predev` hook).

### `src/` — Frontend
- `main.tsx` / `App.tsx` — entry point and root component / routing between views.
- `context/` — global React state:
  - `ThemeContext` — 8 themes with Clean Mono as the default and user selection persisted.
  - `LanguageContext` — i18n (en/ru/zh); exposes `useI18n().t`, persists setting `lang`,
    and defaults to English on first run.
  - `DownloadsContext` — download queue, concurrency limit, live progress events.
  - `DragContext` — drag-and-drop state for the library.
  - `LanContext` — LAN: visibility (setting `lanVisible`), discovered peers, transfers,
    incoming-offer modal, current watch-together room.
- `components/` — reusable UI: `Sidebar`, `Settings`, `DownloadsPanel`, `Splash`,
  `Toast`, `Typewriter`, `ThemeSwitcher`, `Logo`, `LibraryPicker` (library + storage-root
  files for LAN send and the room queue), `CommandPalette` (desktop Ctrl+K: paste/download a
  link, jump to a section, search the library, switch theme), `AnimatedNumber` (spring %).
- `lib/`:
  - `ipc.ts` — typed wrappers over Tauri `invoke` (the single bridge to Rust).
  - `db.ts` — SQLite access (history, library structure, metadata).
  - `i18n.ts` — trilingual dictionary (`ru`/`en`/`zh`) + `t()`; module-level `t()` for
    non-React code (e.g. `humanizeError`, desktop notifications).
  - `platform.ts` — `IS_ANDROID` (hides tray, explorer, mini-window, cookies, uninstall)
  - `appIcon.ts` — logo marks (`LOGO_MARK`) + `applyThemeIcon()`: favicon/window/tray icon in the theme accent (called from ThemeContext); Android — launcher icon via per-theme `activity-alias` (`LauncherIcon.kt`, switched in `MainActivity.onStop`); base icon is black-and-white (`design/logo/app-icon.svg`); concept sources in `design/logo/`
    and URL extraction from shared text.
  - `roomSync.ts` — watch-together drift correction (seek on big drift, ±10% rate on small,
    self-tuning start lead).
  - `media.ts` — `useMediaSrc` (desktop: asset://; Android: `local_media_url` from media.rs,
    because Tauri's Android asset protocol serves Range in 1 MB chunks and audio >1 MB never
    loads) and `setPlaybackActive` (Android PlaybackService while something plays).
- `views/` — top-level screens:
  - `Addons` — desktop and Android catalog. On Windows x64, Transcription installs its engine. The tag editor and Nearby
    (file transfers and watch together) install separate packages. Installed files determine
    availability, and uninstall removes the corresponding worker from disk.
  - `Transcription` — desktop-only local speech recognition for library files. Each model can
    be downloaded before recognition or removed from the cache individually.
  - `Downloader` — paste URL, pick format/quality, start downloads.
  - `Locker` — the media library (folders + videos grid, multi-select, drag-drop).
    Refreshes scan the current folder in order. Missing entries are pruned only after successful
    scans with a grace period. Search covers the full library and ignores outdated responses.
  - `History` — past downloads with statuses; resume interrupted (`.part`) downloads.
  - `Player` / `MiniPlayer` — main and floating video/audio players; playback position
    persisted per file.
  - `Nearby` — LAN devices: visibility toggle, send files, manual add by address, rooms.
  - `Room` — watch-together player with a queue (host adds/reorders, auto-advance;
    guests suggest their own files).
- `types.ts` — shared TypeScript types.

### `src-tauri/` — Backend
- `src/main.rs` — thin entry, calls `mestia_lib::run()`.
- `src/lib.rs` — registers plugins, restores the existing desktop window on a second launch,
  builds the tray, handles smart close, and exposes the Tauri commands the frontend calls.
- `src/transcription.rs` — caches verified Whisper models from Hugging Face, prepares library audio
  with FFmpeg, and streams logs from the local whisper-cli executable.
  Windows x64 can install verified CPU and CUDA builds from the official whisper.cpp release.
  The Windows x64 add-on installs the CPU engine before enabling recognition. Removing it deletes
  managed engines and offers to keep cached models. The catalog shows the space used and can
  remove leftover downloads after uninstall. Existing models are reused on installation.
  The saved transcription device preference controls GPU use and automatic CPU fallback.
  Recognition options persist the spoken language, English translation (excluding Turbo/.en models),
  and timestamped SRT output. Omitted options retain automatic language detection and plain text.
  Whisper decodes each audio window without reusing earlier text. Captions fully inside long,
  near-silent intervals detected by FFmpeg are removed without shifting the remaining timestamps.
  The open transcription view stays mounted across navigation and exports transcripts as TXT or Markdown.
  The desktop library reads and writes common embedded media tags with FFprobe and lossless FFmpeg remuxing.
- `src/downloader.rs` — builds `yt-dlp` arguments (metadata, download), parses and
  emits progress/item/done events.
- `src/engine.rs` — runs `yt-dlp` and streams its output line by line: desktop → sidecar
  via tauri-plugin-shell; Android → Kotlin plugin. Owns cancel (incl. cancel before start).
- `src/mobile.rs` — Android bridge to `MestiaPlugin` (Kotlin): storage root, thumbnails
  (MediaMetadataRetriever), open file (FileProvider), MediaStore scan, share intent,
  move-to-back, yt-dlp update.
- `gen/android/` — Android Studio project. `MestiaPlugin.kt` wraps youtubedl-android
  (Python + yt-dlp + ffmpeg); `DownloadService.kt` — foreground service while downloads
  run; `PlaybackService.kt` — mediaPlayback foreground service with MediaSession notification (title, cover, seek bar, ⏮⏯⏭ → `media://action`) + wake/Wi-Fi lock while
  the player or a room plays (works with the screen off); `MainActivity.kt` — system-bar insets; manifest — `ACTION_SEND text/plain` share
  target, `extractNativeLibs`.
- `src/storage.rs` — filesystem ops: files/folders, real-time file-watcher, thumbnail
  generation (ffmpeg, cached), settings.
- `src/addons.rs` — Windows x64 package installation. `src/addon_runtime.rs` and `src/addon_wire.rs` host workers over private stdio.
  `addon-workers/` builds separate executables using `src/media_tags.rs` and `src/lan.rs`, with
  shared `desktop_process.rs`, `file_paths.rs` and `local_network.rs`. Other desktop targets compile
  their existing commands into the app. `npm run build-addons` signs the package manifests
  with the updater key. CI attaches the ZIPs to the matching GitHub release. For a debug
  client, `MESTIA_ADDON_DEV_DIR` and `MESTIA_ADDON_DEV_PUBKEY` select locally signed fixtures.
- `src/android_addons.rs` — downloads per-ABI split APKs from the matching GitHub release.
  `AddonInstaller.kt` delegates installation and removal to Android's package installer.
  `scripts/build-android-addons.py` builds the worker splits and checks the certificate against the base APK before upload.
  The base APK retains local playback and downloading. Nearby's worker delegates Android wake locks, transfer notifications, and MediaStore scans to the host.
- `src/lan.rs` — LAN: UDP announces (multicast 239.255.77.18 + subnet broadcast, port
  53318), axum HTTP/WS server on TCP 53318 (`/api/info`, `/api/offer`, `/api/upload`,
  `/api/room`, `/api/room/media` with Range, `/api/room/ws`), sender via reqwest,
  watch-together guest via tokio-tungstenite with NTP-like clock offset. Every route rejects
  `Origin` (browser pages) and non-IP `Host` (DNS rebinding); LAN clients bypass system proxy.
- `src/media.rs` — Android loopback media server (127.0.0.1, random port, per-file token).
- `migrations/0001_init.sql` — SQLite schema (applied automatically).
- `capabilities/default.json` — Tauri plugin permissions; `desktop.json` — desktop-only
  (updater). `tauri.android.conf.json` drops sidecars and sets minSdk 30.
- `tauri.conf.json` — window, tray, sidecar registration, asset protocol, NSIS
  installer, and GitHub-Releases auto-updater config.

## Key flows
- **LAN share**: sender `lan_send` → POST `/api/offer` → receiver shows modal (90 s) →
  `lan_answer_offer` → session → PUT `/api/upload` per file into the storage root
  (`.name.mestia-part` → rename) → `lan://received`. A transfer holds `lan::Awake` from the
  «Send»/«Accept» tap until the session ends (or `SESSION_IDLE` without data): Android —
  `DownloadService` (foreground + wake/Wi-Fi lock, % in its notification); desktop — a
  system sleep block (`keepawake`, held on a dedicated thread).
- **Watch together**: host `lan_room_start` (room title in announces) and pushes player
  state via `lan_room_state`; guest `lan_room_join` streams `/api/room/media`, gets
  `lan://room-state` (time already in local clock) and corrects drift (`roomSync.ts`);
  guest controls send `lan_room_cmd` to the host. Queue: host owns it (`lan_room_add/move/
  remove/play`), broadcasts `{t:"queue"}`; on `ended` the host plays the next item. A guest
  `lan_room_propose` registers a token in its own `/api/share/media` and the item streams
  from the guest's device; its items drop when the guest leaves. Android: `MulticastLock`
  (`lanMulticast`), cleartext HTTP allowed for LAN media. The room can be minimized to a
  pill (playback continues); Library selection → «Отправить» (`SendToDevice`) / «В очередь».

- **Download**: intermediate streams/`.part` go to hidden `<dir>/.mestia-tmp` (`-P temp:`), only the
  final file lands in the library; `Combined` in `downloader.rs` turns per-stream progress (video,
  then audio) into one percent of the final file (also shown in the Android download notification).
  Active and queued tasks are persisted in SQLite and offered for resumption after restart; known
  single-item sizes are checked against free storage with a processing allowance before download.
  `Downloader` view → `ipc.ts` → `downloader.rs` (builds args) →
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
  stays in sync; on Android the grid rescans on focus. Android's scoped storage hides
  media the app didn't create, so the Locker asks for READ_MEDIA_VIDEO/AUDIO
  (`ensure_media_access`, once per launch) and rescans as soon as it is granted. Thumbnails are
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
