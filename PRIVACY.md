# Политика конфиденциальности · Privacy Policy

[Русский](#русский) · [English](#english)

_Последнее обновление / Last updated: 25.10.2026_

---

## Русский

**Коротко:** Mestia не собирает, не хранит у себя и никуда не отправляет ваши
персональные данные. В приложении нет аккаунтов, рекламы, аналитики и телеметрии.
Всё, что вы скачиваете и смотрите, остаётся на вашем устройстве.

### Какие сетевые запросы делает приложение

Mestia выходит в сеть только для того, что вы сами попросили сделать:

| Куда | Когда и зачем |
|---|---|
| Сайт, ссылку на который вы вставили (YouTube, VK и т.д.) | Получить сведения о видео и скачать его. Запросы делает встроенный движок [yt-dlp](https://github.com/yt-dlp/yt-dlp) напрямую с вашего устройства. |
| `github.com` / `objects.githubusercontent.com` | Проверка новой версии приложения при запуске (Windows, macOS, Linux) и обновление движка yt-dlp по кнопке в настройках. Передаётся только обычный HTTP-запрос к файлам релиза. |
| `open.spotify.com`, `music.apple.com` | Только если вы вставили ссылку на трек Spotify или Apple Music — чтобы узнать исполнителя и название и найти этот трек на YouTube. |
| Устройства в вашей локальной сети | Только когда включена видимость в разделе «Рядом»: UDP-анонсы и HTTP/WebSocket на порту 53318 — для обмена файлами и совместного просмотра. В интернет эти данные не уходят. |
| Ваш прокси-сервер | Только если вы сами указали его в настройках. |

Приложение не отправляет разработчику ни запросы, ни историю, ни какие-либо идентификаторы.

### Что хранится на устройстве

- Скачанные файлы — в выбранной вами папке.
- База `mestia.db`: медиатека, папки, история загрузок.
- Настройки, кэш превью, позиции воспроизведения и громкость.

Всё это лежит в папках приложения на вашем устройстве и удаляется вместе с ним
(скачанные файлы остаются в вашей папке, пока вы их не удалите).

**Куки браузера.** Если вы сами выберете браузер в настройках (только компьютер),
yt-dlp читает его куки локально, чтобы скачивать приватные или возрастные видео.
Куки никуда, кроме сайта-источника, не передаются и приложением не сохраняются.

### Разрешения Android

- **Уведомления** — прогресс загрузки и медиапанель плеера.
- **Фоновые службы** (загрузка, воспроизведение) — чтобы загрузка и звук не
  прерывались в фоне и с выключенным экраном.
- **Доступ ко всем файлам** — запрашивается, только если вы выберете папку загрузок
  вне «Загрузок».
- **Multicast Wi-Fi** — поиск устройств в разделе «Рядом».
- **Интернет** — загрузка.

### Дети

Приложение не предназначено специально для детей и не собирает данных ни о ком,
в том числе о детях.

### Изменения

Если политика изменится, новая версия появится в этом файле и на
[сайте](https://kweharmony.github.io/Mestia/privacy.html) с новой датой.

### Контакты

Вопросы — через [Issues на GitHub](https://github.com/kweharmony/Mestia/issues).
Уязвимости — см. [SECURITY.md](SECURITY.md).

---

## English

**In short:** Mestia does not collect, store on any server, or send anywhere your
personal data. There are no accounts, ads, analytics or telemetry. Everything you
download and watch stays on your device.

### Network requests the app makes

Mestia only goes online to do what you asked for:

| Where | When and why |
|---|---|
| The site whose link you pasted (YouTube, VK, etc.) | To fetch video info and download it. Requests are made directly from your device by the bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp) engine. |
| `github.com` / `objects.githubusercontent.com` | Checking for a new app version on launch (Windows, macOS, Linux) and updating yt-dlp when you press the button in Settings. Only a plain HTTP request for release files. |
| `open.spotify.com`, `music.apple.com` | Only when you paste a Spotify or Apple Music track link — to read the artist and title and find that track on YouTube. |
| Devices on your local network | Only while visibility is on in “Nearby”: UDP announcements and HTTP/WebSocket on port 53318 for file sharing and watching together. This traffic never leaves your network. |
| Your proxy server | Only if you set one in Settings. |

The app never sends the developer your requests, history or any identifiers.

### What is stored on the device

- Downloaded files — in the folder you choose.
- `mestia.db`: library, folders, download history.
- Settings, thumbnail cache, playback positions and volume.

All of it lives in the app's folders on your device and is removed with the app
(downloaded files stay in your folder until you delete them).

**Browser cookies.** If you choose a browser in Settings (desktop only), yt-dlp reads
its cookies locally to download private or age-restricted videos. Cookies are sent
only to the source site and are not stored by the app.

### Android permissions

- **Notifications** — download progress and the player's media panel.
- **Foreground services** (download, playback) — so downloads and sound continue in
  the background and with the screen off.
- **All files access** — requested only if you pick a download folder outside
  “Downloads”.
- **Wi-Fi multicast** — discovering devices in “Nearby”.
- **Internet** — downloading.

### Children

The app is not directed at children and collects no data about anyone, children
included.

### Changes

If this policy changes, the new version will appear in this file and on the
[website](https://kweharmony.github.io/Mestia/privacy.html) with a new date.

### Contact

Questions — via [GitHub Issues](https://github.com/kweharmony/Mestia/issues).
Vulnerabilities — see [SECURITY.md](SECURITY.md).
