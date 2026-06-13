# CLAUDE.md

Guidance for AI agents working in this repository.

## Project

**Mestia** — cross-platform desktop app for downloading video/audio and managing a
media library. A GUI wrapper around `yt-dlp` with a built-in player, file manager,
and themes.

## Tech Stack

- **Backend:** Rust + Tauri v2 (`src-tauri/`)
- **Frontend:** React 18 + TypeScript + Vite 6 (`src/`)
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`)
- **Animation:** `framer-motion` (layout/exit transitions, sliding tab pills); global
  `<MotionConfig reducedMotion="user">` honors OS reduced-motion. Motion-animated
  elements carry the `.mestia-anim` class so the global CSS `transform`/`opacity`
  transition doesn't fight framer's per-frame writes.
- **Database:** SQLite via `tauri-plugin-sql` (migrations in `src-tauri/migrations/`)
- **Sidecars:** `yt-dlp` + `ffmpeg`/`ffprobe` (bundled per-OS into `src-tauri/binaries/`)
- **Package manager:** npm

## Commands

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Fetch sidecar binaries | `npm run fetch-binaries` |
| Dev (full app) | `npm run tauri dev` |
| Dev (frontend only) | `npm run dev` |
| Build frontend + typecheck | `npm run build` (`tsc --noEmit && vite build`) |
| Build installers | `npm run tauri build` |
| Tauri CLI | `npm run tauri -- <args>` |

Notes:
- `predev` hook frees port 1420 before `npm run dev`.
- No test runner or linter is configured. Type-checking is `tsc --noEmit` (via `npm run build`).
- Sidecar binaries must be fetched **before** `tauri build`.

## Architecture

```
flatpak/            Flatpak packaging for Steam Deck/SteamOS: manifest (com.mestia.app.yml),
                    .desktop and metainfo.xml. Wraps the built .deb in the GNOME runtime
                    (bundles WebKitGTK). Built in CI (release.yml) on the Linux leg.
docs/               GitHub Pages landing site (self-contained index.html: all 8 app
                    themes + theme switcher, app blurb, download links). Static, not
                    part of the app build.
scripts/            Node scripts: fetch-binaries.mjs, free-port.mjs
src/                Frontend (React + TS)
  context/          React contexts: ThemeContext, DownloadsContext (queue/events), DragContext
  components/       UI: Sidebar, Settings, DownloadsPanel, Splash, Toast, Typewriter, ThemeSwitcher, Logo
  lib/              ipc.ts (bridge to Rust commands), db.ts (SQLite access)
  views/            Downloader, Locker (library), History, Player, MiniPlayer
  types.ts          Shared TS types
src-tauri/          Backend (Rust + Tauri v2)
  src/lib.rs        Plugins, tray, smart-close, command registration (mestia_lib::run)
  src/downloader.rs yt-dlp: metadata, download, cancel, progress events
  src/storage.rs    Files, folders, file-watcher, thumbnails, settings
  src/main.rs       Entry point -> mestia_lib::run()
  migrations/       SQLite schema
  capabilities/     Plugin permissions (default.json)
  tauri.conf.json   Window, tray, sidecar, asset protocol, NSIS, updater
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
- **Comments in code are Russian** (matching the existing codebase); UI strings are Russian.
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
