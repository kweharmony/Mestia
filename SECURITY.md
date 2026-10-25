# Безопасность · Security Policy

[Русский](#русский) · [English](#english)

---

## Русский

### Поддерживаемые версии

Исправления безопасности выходят только для **последнего релиза**. На компьютере
приложение обновляется само; на Android поставьте свежий APK из
[релизов](https://github.com/kweharmony/Mestia/releases/latest).

### Как сообщить об уязвимости

Пожалуйста, **не создавайте публичный issue**. Отправьте закрытый отчёт через
[GitHub Security Advisories](https://github.com/kweharmony/Mestia/security/advisories/new)
(вкладка Security → Report a vulnerability).

В отчёте укажите:
- платформу и версию Mestia;
- что именно уязвимо и как это воспроизвести;
- возможные последствия.

Ответ — в течение 7 дней. После исправления выйдет релиз, а в его описании будет
благодарность (если вы не против).

### Что входит в область

- Сервер локальной сети «Рядом» (`src-tauri/src/lan.rs`, порт 53318): доступ к файлам,
  обход подтверждения приёма, доступ из браузера или по DNS-rebinding.
- Локальный медиасервер Android (`src-tauri/src/media.rs`).
- Авто-обновление и его подпись.
- Обработка ссылок и аргументов, передаваемых в yt-dlp / ffmpeg.
- Kotlin-плагин и Android-сервисы (`src-tauri/gen/android/`).

Уязвимости самих yt-dlp, ffmpeg, WebView или Tauri отправляйте их авторам; если они
задевают Mestia — сообщите и нам.

### Что уже сделано

- Обновления подписываются (minisign); без верной подписи апдейтер их не ставит.
- Сервер «Рядом» отклоняет запросы с заголовком `Origin` (страницы браузера) и с
  не-IP `Host` (защита от DNS-rebinding); приём файлов — только после подтверждения.
- Локальный медиасервер Android слушает только `127.0.0.1` и выдаёт файлы по
  токенам, выданным на каждый файл.
- Ссылка передаётся в yt-dlp после `--`, чтобы её нельзя было принять за опцию.

---

## English

### Supported versions

Security fixes ship for the **latest release** only. On desktop the app updates
itself; on Android install the latest APK from
[releases](https://github.com/kweharmony/Mestia/releases/latest).

### Reporting a vulnerability

Please **do not open a public issue**. Send a private report through
[GitHub Security Advisories](https://github.com/kweharmony/Mestia/security/advisories/new)
(Security tab → Report a vulnerability).

Include:
- platform and Mestia version;
- what is vulnerable and how to reproduce it;
- possible impact.

You'll get a reply within 7 days. Once fixed, a release will follow, with credit in
its notes if you'd like.

### Scope

- The “Nearby” LAN server (`src-tauri/src/lan.rs`, port 53318): file access,
  bypassing receive confirmation, access from a browser or via DNS rebinding.
- The Android local media server (`src-tauri/src/media.rs`).
- Auto-update and its signature.
- Handling of links and arguments passed to yt-dlp / ffmpeg.
- The Kotlin plugin and Android services (`src-tauri/gen/android/`).

Report bugs in yt-dlp, ffmpeg, WebView or Tauri themselves to their authors; if they
affect Mestia, let us know too.

### Already in place

- Updates are signed (minisign); the updater won't install them without a valid
  signature.
- The Nearby server rejects requests carrying an `Origin` header (browser pages) and
  non-IP `Host` values (DNS-rebinding protection); files are accepted only after
  confirmation.
- The Android media server listens on `127.0.0.1` only and serves files by
  per-file tokens.
- Links are passed to yt-dlp after `--` so they can't be read as options.
