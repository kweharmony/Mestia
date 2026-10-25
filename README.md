<div align="center">

<img src="app-icon.png" width="96" alt="Mestia" />

# Mestia

**Скачивай. Храни. Смотри.**<br/>
Видео и музыка с 1800+ площадок — в медиатеке со своим плеером. Для компьютера и телефона.

[![Релиз](https://img.shields.io/github/v/release/kweharmony/Mestia?label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7&color=1a1a1a)](https://github.com/kweharmony/Mestia/releases/latest)
[![Лицензия: MIT](https://img.shields.io/badge/%D0%BB%D0%B8%D1%86%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F-MIT-1a1a1a)](LICENSE)
![Платформы](https://img.shields.io/badge/Windows%20%C2%B7%20Linux%20%C2%B7%20Android-1a1a1a)

**Русский** · [English](README.en.md) · [Сайт](https://kweharmony.github.io/Mestia/)

<a href="docs/media/promo.mp4"><img src="docs/media/promo.webp" width="860" alt="Mestia: вставить ссылку, скачать, смотреть" /></a>

</div>

---

## Возможности

**Загрузка**
- Ссылки с **1800+ площадок** — всё, что умеет [yt-dlp](https://github.com/yt-dlp/yt-dlp): YouTube, VK, Rutube, TikTok, SoundCloud…
- Видео до 4K или звук (MP3, M4A, OPUS, FLAC, WAV); **плейлисты** целиком или выборочно (`1-5, 8`).
- Фоновая очередь, **один процент для готового файла** (видео и аудио считаются вместе),
  промежуточные файлы не видны в медиатеке, прерванные загрузки продолжаются.
- Spotify и Apple Music — трек находится и скачивается с YouTube по названию.

**Медиатека и плеер**
- Папки, превью, перетаскивание, множественный выбор, поиск; изменения на диске подхватываются сами.
- Плеер с управлением поверх кадра, аудио — карточкой с обложкой; помнит позицию каждого файла.
- **Ctrl+K** — палитра команд: вставить ссылку, найти файл, сменить тему, перейти в раздел.

**Android**
- **Медиапанель в шторке** с обложкой и кнопками, воспроизведение с выключенным экраном.
- Процент загрузки в уведомлении; «**Поделиться → Скачать в Mestia**» из YouTube и браузера.

**Рядом** — без интернета
- Обмен файлами компьютер ↔ телефон по Wi-Fi или точке доступа, с подтверждением приёма.
- **Смотреть вместе**: синхронное воспроизведение с очередью, поток с устройства ведущего.

**Оформление**
- 8 тем; иконка приложения меняется под тему (на Android — и значок на рабочем столе).
- Интерфейс на русском, английском и китайском.

## Скачать

| Платформа | Файл | Статус |
|---|---|---|
| **Windows 10/11** | `Mestia_*_x64-setup.exe` | ✅ протестировано, обновляется само |
| **Linux** | `.AppImage`, `.deb`, `Mestia.flatpak` | ⚠️ экспериментально |
| **Android 11+** | `*_android_arm64.apk` (почти все телефоны), `*_android_armv7.apk` | ⚠️ экспериментально |
| **macOS** | `.dmg` (universal) | ⚠️ экспериментально, не нотаризовано |

👉 **[Последний релиз](https://github.com/kweharmony/Mestia/releases/latest)**. В Google Play приложения нет: загрузчики YouTube там запрещены.

<details>
<summary><b>Linux: версии, кодеки, трей</b></summary>

- `.deb`/AppImage собираются на Ubuntu 22.04 и требуют **glibc ≥ 2.35** и **webkit2gtk-4.1**.
  На старых дистрибутивах — берите **Flatpak**: он несёт свой рантайм.
- Видео в плеере не играет («Не удалось воспроизвести файл») — поставьте кодеки GStreamer
  (в `.deb` они подтягиваются сами, в AppImage — нет):
  ```bash
  sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly
  ```
- Значок в трее требует AppIndicator; без него («ванильный» GNOME) трея может не быть — на работу это не влияет.
</details>

<details>
<summary><b>Steam Deck (SteamOS)</b></summary>

Системного WebKitGTK там нет, поэтому `.deb` не ставится, а AppImage даёт пустое окно. Используйте Flatpak:

```bash
flatpak install --user ./Mestia.flatpak
flatpak run com.mestia.app
```

Для игрового режима добавьте Mestia в Steam как стороннюю игру с командой `flatpak run com.mestia.app`.
Во Flatpak встроенный апдейтер не применяется — обновления через `flatpak update`.
</details>

<details>
<summary><b>macOS: «приложение повреждено»</b></summary>

Сборки подписаны ad-hoc и не нотаризованы, поэтому Gatekeeper ругается. Снимите карантин один раз:

```bash
xattr -cr /Applications/Mestia.app
```
</details>

<details>
<summary><b>Android: что стоит знать</b></summary>

- yt-dlp, Python и ffmpeg встроены через [youtubedl-android](https://github.com/JunkFood02/youtubedl-android) (GPL-3.0).
  Первый запуск чуть дольше — распаковывается Python.
- Файлы — в **Загрузки → Mestia** (папку можно сменить), видео и музыка появляются в галерее.
- Нет: куки браузера, трея, мини-окна и самообновления (новые версии — APK из релизов).
  Движок yt-dlp обновляется из настроек.
</details>

## Какие сайты поддерживаются

Всё из [списка yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) — видеохостинги, соцсети,
аудиоплощадки, прямые ссылки на mp4/m3u8. Spotify и Apple Music — через поиск на YouTube;
Звук и VK Музыка — по названию, введённому вручную. Сервисы с DRM (Netflix, Кинопоиск, Okko, ivi,
Яндекс Музыка, Disney+, Prime Video…) не скачиваются — приложение сразу об этом скажет.
Приватные и возрастные видео — с куками браузера (настройки, только компьютер); геоблок — через прокси.

## Конфиденциальность

Никакой телеметрии, аналитики и аккаунтов — всё остаётся на устройстве. Подробно: [PRIVACY.md](PRIVACY.md).

## Сборка из исходников

Нужны **Node.js 18+**, **Rust (stable)** и [системные зависимости Tauri](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run fetch-binaries   # yt-dlp + ffmpeg/ffprobe под вашу ОС → src-tauri/binaries/
npm run tauri dev        # запуск в режиме разработки
npm run tauri build      # установщики → src-tauri/target/release/bundle/
```

| Действие | Команда |
|---|---|
| Проверка типов + сборка фронтенда | `npm run build` |
| Тесты фронтенда (Vitest) | `npm test` |
| Тесты Rust | `cargo test` (в `src-tauri/`) |
| Android: разработка / APK | `npm run tauri android dev` / `npm run tauri android build -- --apk` |

<details>
<summary><b>Подробнее: Windows, Linux, Android, релизы</b></summary>

- **Windows:** Microsoft C++ Build Tools (`winget install Microsoft.VisualStudio.2022.BuildTools`), WebView2 (обычно уже есть).
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Android:** Android SDK + NDK, JDK 17+, переменные `ANDROID_HOME` и `NDK_HOME`. Релизный APK
  подписывается ключом из `src-tauri/gen/android/keystore.properties` (в `.gitignore`); в CI он
  собирается из секретов `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
  **Ключ нельзя терять и менять** — иначе обновление поверх старой версии не встанет.
- **Релиз:** поднять версию в `package.json` и `src-tauri/tauri.conf.json` (одинаково), запушить тег
  `vX.Y.Z`. Workflow `.github/workflows/release.yml` соберёт и подпишет сборки для всех ОС и приложит
  `latest.json` для апдейтера; затем опубликовать черновик релиза. Подпись апдейтера — секреты
  `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **macOS с нотаризацией:** добавить секреты `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` — CI включит подпись и нотаризацию.
</details>

## Где хранятся данные

- Файлы — в папке загрузок (по умолчанию `Документы/Mestia`, на Android — `Загрузки/Mestia`; меняется в настройках).
  Недокачанные части лежат в скрытой `.mestia-tmp` рядом и нужны для продолжения загрузки.
- `mestia.db` (медиатека, история), настройки и кэш превью — в папке данных приложения.

## Как устроено

Tauri v2 (Rust) + React 18 + TypeScript + Tailwind CSS v4, SQLite, yt-dlp и ffmpeg как sidecar;
на Android — Kotlin-плагин поверх youtubedl-android. Карта модулей и основные сценарии — в
[`.context/index.md`](.context/index.md), правила для разработки — в [CLAUDE.md](CLAUDE.md).

Промо-ролик собирается из `design/promo/promo.html` скриптом `design/promo/render.mjs`.

## Участие

Баги и идеи — в [Issues](https://github.com/kweharmony/Mestia/issues/new/choose), код — по
[CONTRIBUTING.md](CONTRIBUTING.md). Уязвимости — закрыто, по [SECURITY.md](SECURITY.md).
[Правила поведения](CODE_OF_CONDUCT.md).

## Лицензия

[MIT](LICENSE). Android-сборка включает [youtubedl-android](https://github.com/JunkFood02/youtubedl-android)
и как целое распространяется на условиях **GPL-3.0**. Встроенные компоненты: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense),
[FFmpeg](https://ffmpeg.org/legal.html) (LGPL/GPL).
