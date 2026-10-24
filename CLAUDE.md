# CLAUDE.md

Guidance for AI agents working in this repository.

## Project

**Mestia** — cross-platform app (desktop + Android) for downloading video/audio and
managing a media library. A GUI wrapper around `yt-dlp` with a built-in player, file
manager, and themes.

## Tech Stack

- **Backend:** Rust + Tauri v2 (`src-tauri/`)
- **Frontend:** React 18 + TypeScript + Vite 6 (`src/`)
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`)
- **i18n:** свой лёгкий контекст без зависимостей — `src/lib/i18n.ts` (словари
  `ru`/`en`/`zh`, ключ → `{ru,en,zh}`) + `src/context/LanguageContext.tsx`
  (`useI18n().t`). Не-React код зовёт модульный `t()`. Язык хранится в настройке
  `lang` (и `localStorage`), при первом запуске определяется по локали ОС.
- **Animation:** `framer-motion` (layout/exit transitions, sliding tab pills); global
  `<MotionConfig reducedMotion="user">` honors OS reduced-motion. Motion-animated
  elements carry the `.mestia-anim` class so the global CSS `transform`/`opacity`
  transition doesn't fight framer's per-frame writes.
- **Database:** SQLite via `tauri-plugin-sql` (migrations in `src-tauri/migrations/`)
- **Sidecars:** `yt-dlp` + `ffmpeg`/`ffprobe` (bundled per-OS into `src-tauri/binaries/`)
- **Android:** Tauri mobile; yt-dlp/Python/ffmpeg from `youtubedl-android` (GPL-3.0) via an
  app-local Kotlin plugin `MestiaPlugin` (`src-tauri/gen/android/…/com/mestia/app/`).
  Desktop-only code is gated with `#[cfg(desktop)]`, UI with `IS_ANDROID` (`src/lib/platform.ts`).
- **Package manager:** npm

## Commands

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Fetch sidecar binaries | `npm run fetch-binaries` |
| Dev (full app) | `npm run tauri dev` |
| Dev (frontend only) | `npm run dev` |
| Build frontend + typecheck | `npm run build` (`tsc --noEmit && vite build`) |
| Frontend tests | `npm test` (Vitest; files `src/**/*.test.ts`) |
| Rust tests | `cargo test` (run in `src-tauri/`) |
| Build installers | `npm run tauri build` |
| Android dev / APK | `npm run tauri android dev` / `npm run tauri android build -- --apk` (needs `ANDROID_HOME`, `NDK_HOME`) |
| Tauri CLI | `npm run tauri -- <args>` |

Notes:
- `predev` hook frees port 1420 before `npm run dev`.
- Tests: Vitest for frontend pure logic (`npm test`), `cargo test` for Rust. No linter configured.
  Type-checking is `tsc --noEmit` (via `npm run build`).
- Sidecar binaries must be fetched **before** `tauri build`.

## Architecture

```
flatpak/            Flatpak packaging for Steam Deck/SteamOS: manifest (com.mestia.app.yml),
                    .desktop and metainfo.xml. Wraps the built .deb in the GNOME runtime
                    (bundles WebKitGTK). Built in CI (release.yml) on the Linux leg.
design/logo/        Logo concept SVGs + concepts.png (5 directions); not part of the build.
docs/               GitHub Pages landing site (self-contained index.html: all 8 app
                    themes + theme switcher, app blurb, download links). Static, not
                    part of the app build.
scripts/            Node scripts: fetch-binaries.mjs, free-port.mjs
src/                Frontend (React + TS)
  context/          React contexts: ThemeContext, LanguageContext (i18n), DownloadsContext (queue/events), DragContext,
                    LanContext (LAN visibility/peers/transfers/incoming offers/room)
  components/       UI: Sidebar, Settings, DownloadsPanel, Splash, Toast, Typewriter, ThemeSwitcher, Logo,
                    LibraryPicker (pick library/disk files for LAN send & room queue)
  lib/              ipc.ts (bridge to Rust commands), db.ts (SQLite access), i18n.ts (ru/en/zh dictionary + t()),
                    platform.ts (IS_ANDROID, share-text URL extraction),
                    appIcon.ts (logo marks + theme-coloured favicon/window/tray icon), roomSync.ts (watch-together drift correction)
  views/            Downloader, Locker (library), History, Player, MiniPlayer, Nearby (LAN devices/transfers),
                    Room (watch-together player + queue)
  types.ts          Shared TS types
src-tauri/          Backend (Rust + Tauri v2)
  src/lib.rs        Plugins, tray, smart-close, command registration (mestia_lib::run)
  src/downloader.rs yt-dlp args: metadata, download, progress/item events
  src/engine.rs     yt-dlp runner: desktop sidecar / Android Kotlin plugin; cancel
  src/mobile.rs     Android bridge to MestiaPlugin (storage root, thumbnails, share, update)
  src/storage.rs    Files, folders, file-watcher, thumbnails, settings
  src/lan.rs        LAN: UDP discovery, axum HTTP/WS server, file offers/uploads, watch-together room + clock sync
  src/main.rs       Entry point -> mestia_lib::run()
  migrations/       SQLite schema
  capabilities/     Plugin permissions (default.json; desktop.json — desktop-only)
  tauri.conf.json   Window, tray, sidecar, asset protocol, NSIS, updater
  tauri.android.conf.json  Android overrides (no sidecars, minSdk 30)
  gen/android/      Android Studio project: MestiaPlugin.kt, DownloadService.kt (foreground
                    service), MainActivity.kt (insets), manifest (share intent), Gradle deps
```

The frontend calls Rust via `src/lib/ipc.ts`. Rust emits download progress and
file-watcher events back to the frontend.

## Token-Saving Rules (for AI agents)

- **Do not rewrite whole files.** Edit only the relevant lines; use `// ... existing code ...`
  markers to elide unchanged regions when proposing edits.
- **Be terse.** No preamble, no flattery, no restating the question. Answer directly.
- **Minimal context reads.** Read only the section of a file you need, not the whole file.
- **Match existing style** — naming, comment density, idioms of surrounding code.
- **No unsolicited refactors.** Change what was asked; flag other issues briefly instead
  of fixing them inline.
- **Comments in code are Russian** (matching the existing codebase). **UI strings go
  through i18n** — never hardcode user-facing text: add a key to `src/lib/i18n.ts`
  (with `ru`/`en`/`zh`) and render via `useI18n().t("key")` (or module `t()` in
  non-React code). Rust backend messages remain Russian; `humanizeError` maps the
  common ones to translated keys.
- Keep `package.json` and `src-tauri/tauri.conf.json` versions in sync when bumping.

## Keeping This Documentation Current

These files describe the project's structure and must be updated **in the same change**
that alters what they describe. Before finishing a task, check:

- **Added/removed/renamed a folder or key module** (e.g. a new `src/views/*`, a new
  Rust source file, a new context) → update the architecture map here, in `.cursorrules`,
  and in `.context/index.md`.
- **Changed scripts in `package.json`** (build/dev/test/format commands) → update the
  Commands table here and in `.cursorrules`.
- **Changed the stack** (added a dependency that defines a layer — a test runner, linter,
  state lib, etc.) → update the Tech Stack section in all three docs.
- **Changed a core flow** (download / library / auto-update) → update the flow notes in
  `.context/index.md`.

If a change does not touch structure, commands, stack, or flows, these docs need no edit.
Update only the lines that became wrong — do not rewrite the files.
