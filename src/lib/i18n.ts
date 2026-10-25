// Лёгкий свой i18n без зависимостей. Словарь ключ → {ru, en, zh}; язык хранится
// в настройках (ключ `lang`) и дублируется на модульном уровне, чтобы перевод был
// доступен и не-React коду (humanizeError, десктоп-уведомления).

export type Lang = "ru" | "en" | "zh";

export const LANGS: Lang[] = ["ru", "en", "zh"];

/** Названия языков (в собственном написании) — для селектора в настройках. */
export const LANG_LABELS: Record<Lang, string> = {
  ru: "Русский",
  en: "English",
  zh: "中文",
};

export const LANG_STORAGE_KEY = "mestia.lang";

/** Определение языка по локали ОС; всё, кроме zh/en, → русский. */
export function detectLang(): Lang {
  const n = (navigator.language || "").toLowerCase();
  if (n.startsWith("zh")) return "zh";
  if (n.startsWith("en")) return "en";
  return "ru";
}

function readInitial(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null;
    if (saved && LANGS.includes(saved)) return saved;
  } catch {
    /* нет localStorage — не критично */
  }
  return detectLang();
}

// Активный язык на уровне модуля (для не-React вызовов). React-код меняет его
// через LanguageContext → setActiveLang.
let active: Lang = readInitial();

export function getLang(): Lang {
  return active;
}

export function setActiveLang(l: Lang): void {
  active = l;
}

type Entry = Record<Lang, string>;

const DICT: Record<string, Entry> = {
  // ── Общее ────────────────────────────────────────────────────────────────
  "common.cancel": { ru: "Отмена", en: "Cancel", zh: "取消" },
  "common.delete": { ru: "Удалить", en: "Delete", zh: "删除" },
  "common.change": { ru: "Изменить", en: "Change", zh: "更改" },

  // ── Боковая панель ───────────────────────────────────────────────────────
  "nav.downloader": { ru: "Загрузчик", en: "Downloader", zh: "下载" },
  "nav.locker": { ru: "Медиатека", en: "Library", zh: "媒体库" },
  "nav.history": { ru: "История", en: "History", zh: "历史" },
  "nav.nearby": { ru: "Рядом", en: "Nearby", zh: "附近" },
  "sidebar.collapse": { ru: "Свернуть панель", en: "Collapse sidebar", zh: "收起侧栏" },
  "sidebar.expand": { ru: "Развернуть панель", en: "Expand sidebar", zh: "展开侧栏" },
  "sidebar.tray": { ru: "Свернуть в трей", en: "Minimize to tray", zh: "最小化到托盘" },
  "sidebar.trayTitle": {
    ru: "Свернуть в трей (загрузка продолжится фоном)",
    en: "Minimize to tray (downloads continue in background)",
    zh: "最小化到托盘（下载将在后台继续）",
  },
  "sidebar.settings": { ru: "Настройки", en: "Settings", zh: "设置" },

  // ── Загрузчик ────────────────────────────────────────────────────────────
  "dl.title": { ru: "Что будем скачивать?", en: "What are we downloading?", zh: "要下载什么？" },
  "dl.check": { ru: "Проверить", en: "Check", zh: "检查" },
  "dl.ph.0": { ru: "Кидай ссылку — дальше моя забота…", en: "Drop a link — I'll take it from here…", zh: "贴上链接 — 剩下的交给我…" },
  "dl.ph.1": { ru: "YouTube, Rutube, VK… неси любую ссылку…", en: "YouTube, Rutube, VK… bring any link…", zh: "YouTube、Rutube、VK… 任何链接都行…" },
  "dl.ph.2": { ru: "Плейлист на 100 видео? Да без проблем…", en: "A 100-video playlist? No problem…", zh: "100 个视频的播放列表？没问题…" },
  "dl.ph.3": { ru: "Видео или аудио — как пожелаешь…", en: "Video or audio — whatever you like…", zh: "视频或音频 — 悉听尊便…" },
  "dl.ph.4": { ru: "Вставь ссылку и налей себе чаю ☕", en: "Paste a link and pour yourself some tea ☕", zh: "粘贴链接，泡杯茶吧 ☕" },
  "dl.ph.5": { ru: "Спасём ролик, пока его не удалили…", en: "Let's save the video before it's gone…", zh: "趁视频还在，赶紧保存…" },
  "dl.authTitle": { ru: "Похоже, нужен вход в аккаунт", en: "Looks like you need to sign in", zh: "看起来需要登录账户" },
  "dl.authOn": {
    ru: "Куки включены, но доступ не получен. Закройте браузер (Chrome держит свою базу куки заблокированной) или выберите в настройках Firefox.",
    en: "Cookies are on, but access failed. Close the browser (Chrome keeps its cookie database locked) or pick Firefox in settings.",
    zh: "已启用 Cookie，但仍无法访问。请关闭浏览器（Chrome 会锁定其 Cookie 数据库），或在设置中选择 Firefox。",
  },
  "dl.authOff": {
    ru: "Включите «Куки из браузера» в настройках — это часто помогает с приватными, 18+, по подписке и антибот-проверками.",
    en: "Enable “Cookies from browser” in settings — it often helps with private, 18+, subscription and anti-bot checks.",
    zh: "在设置中启用“浏览器 Cookie”——这通常有助于私密、18+、订阅内容和反机器人验证。",
  },
  "dl.authAndroid": {
    ru: "Источник требует вход в аккаунт. На Android куки браузера недоступны — попробуйте прокси в настройках или скачайте на компьютере.",
    en: "The source requires signing in. Browser cookies aren't available on Android — try a proxy in settings or download on a computer.",
    zh: "该来源需要登录。Android 上无法使用浏览器 Cookie——请在设置中尝试代理，或在电脑上下载。",
  },
  "dl.openSettings": { ru: "Открыть настройки", en: "Open settings", zh: "打开设置" },
  "dl.serviceNotDirect": {
    ru: "{service} напрямую не качается",
    en: "{service} can't be downloaded directly",
    zh: "{service} 无法直接下载",
  },
  "dl.thisService": { ru: "Этот сервис", en: "This service", zh: "此服务" },
  "dl.manualHint": {
    ru: "Введите исполнителя и название — найдём и скачаем трек с YouTube.",
    en: "Enter the artist and title — we'll find and download the track from YouTube.",
    zh: "输入艺人和曲名 — 我们将从 YouTube 找到并下载该曲目。",
  },
  "dl.manualPlaceholder": {
    ru: "Например: Rick Astley — Never Gonna Give You Up",
    en: "e.g. Rick Astley — Never Gonna Give You Up",
    zh: "例如：Rick Astley — Never Gonna Give You Up",
  },
  "dl.find": { ru: "Найти", en: "Find", zh: "查找" },
  "dl.playlist": { ru: "Плейлист", en: "Playlist", zh: "播放列表" },
  "dl.videos": { ru: "{count} видео", en: "{count} videos", zh: "{count} 个视频" },
  "dl.alsoPlaylist": {
    ru: "Ссылка ведёт и на плейлист — открыть его",
    en: "The link also points to a playlist — open it",
    zh: "链接也指向一个播放列表 — 打开它",
  },
  "dl.playlistFolder": { ru: "Папка для загрузки", en: "Download folder", zh: "下载文件夹" },
  "dl.playlistFolderHint": {
    ru: "Плейлист скачается в папку с этим именем — можно переименовать.",
    en: "The playlist downloads into a folder with this name — you can rename it.",
    zh: "播放列表将下载到以此命名的文件夹中 — 可以重命名。",
  },
  "dl.wholePlaylist": { ru: "Весь плейлист ({count})", en: "Whole playlist ({count})", zh: "整个播放列表（{count}）" },
  "dl.range": { ru: "Диапазон", en: "Range", zh: "范围" },
  "dl.rangePlaceholder": { ru: "Например: 1-5, 8, 10-12", en: "e.g. 1-5, 8, 10-12", zh: "例如：1-5, 8, 10-12" },
  "dl.video": { ru: "Видео", en: "Video", zh: "视频" },
  "dl.audio": { ru: "Аудио", en: "Audio", zh: "音频" },
  "dl.downloadPlaylist": { ru: "Скачать плейлист", en: "Download playlist", zh: "下载播放列表" },
  "dl.downloadVideo": { ru: "Скачать видео", en: "Download video", zh: "下载视频" },
  "dl.downloadAudio": { ru: "Скачать аудио", en: "Download audio", zh: "下载音频" },
  "dl.dupTitle": { ru: "Уже в медиатеке", en: "Already in library", zh: "已在媒体库中" },
  "dl.dupText": {
    ru: "«{title}» уже скачано. Скачать заново? Существующий файл будет перезаписан.",
    en: "“{title}” is already downloaded. Download again? The existing file will be overwritten.",
    zh: "“{title}”已下载。要重新下载吗？现有文件将被覆盖。",
  },
  "dl.redownload": { ru: "Скачать заново", en: "Download again", zh: "重新下载" },
  "dl.bigTitle": { ru: "Большой плейлист", en: "Large playlist", zh: "大型播放列表" },
  "dl.bigText": {
    ru: "В плейлисте {count} видео. Загрузка займёт много времени и места на диске. Скачать всё? Можно вернуться и выбрать «Диапазон», чтобы взять только часть.",
    en: "The playlist has {count} videos. Downloading will take a lot of time and disk space. Download all? You can go back and choose “Range” to take only part.",
    zh: "该播放列表有 {count} 个视频。下载将耗费大量时间和磁盘空间。要全部下载吗？你可以返回并选择“范围”只下载一部分。",
  },
  "dl.downloadAll": { ru: "Скачать всё", en: "Download all", zh: "全部下载" },
  "dl.rangeNeeded": { ru: "Укажите номера видео, напр. 1-5, 8", en: "Specify video numbers, e.g. 1-5, 8", zh: "请指定视频编号，例如 1-5, 8" },
  "dl.playlistAdded": { ru: "Плейлист добавлен в загрузки", en: "Playlist added to downloads", zh: "播放列表已加入下载" },
  "dl.added": { ru: "Добавлено в загрузки", en: "Added to downloads", zh: "已加入下载" },
  "dl.fetchError": { ru: "Не удалось получить данные по ссылке", en: "Couldn't fetch data for the link", zh: "无法获取该链接的数据" },
  "dl.quality": { ru: "Качество", en: "Quality", zh: "质量" },
  "dl.customize": { ru: "Настроить", en: "Customize", zh: "自定义" },
  "dl.pasteDetected": { ru: "Вставить из буфера", en: "Paste from clipboard", zh: "从剪贴板粘贴" },

  // ── Плеер ────────────────────────────────────────────────────────────────
  "player.prev": { ru: "Предыдущий", en: "Previous", zh: "上一个" },
  "player.next": { ru: "Следующий", en: "Next", zh: "下一个" },
  "player.back": { ru: "Назад {n}с", en: "Back {n}s", zh: "后退 {n} 秒" },
  "player.forward": { ru: "Вперёд {n}с", en: "Forward {n}s", zh: "前进 {n} 秒" },
  "player.backAria": { ru: "Назад", en: "Back", zh: "后退" },
  "player.forwardAria": { ru: "Вперёд", en: "Forward", zh: "前进" },
  "player.sound": { ru: "Звук", en: "Sound", zh: "声音" },
  "player.volume": { ru: "Громкость", en: "Volume", zh: "音量" },
  "player.fullscreen": { ru: "Полный экран", en: "Fullscreen", zh: "全屏" },
  "player.close": { ru: "Закрыть", en: "Close", zh: "关闭" },
  "player.external": { ru: "Открыть во внешнем плеере", en: "Open in external player", zh: "在外部播放器中打开" },
  "player.externalAria": { ru: "Внешний плеер", en: "External player", zh: "外部播放器" },
  "player.miniWindow": { ru: "В отдельном окне", en: "In a separate window", zh: "在单独窗口中" },
  "player.play": { ru: "Играть", en: "Play", zh: "播放" },
  "player.pause": { ru: "Пауза", en: "Pause", zh: "暂停" },
  "player.seek": { ru: "Перемотка", en: "Seek", zh: "进度" },
  "player.subtitles": { ru: "Субтитры", en: "Subtitles", zh: "字幕" },
  "player.fileNotFound": { ru: "Файл не найден", en: "File not found", zh: "未找到文件" },
  "player.playFailed": { ru: "Не удалось воспроизвести файл", en: "Couldn't play the file", zh: "无法播放该文件" },
  "player.missingHint": {
    ru: "Возможно, файл перемещён, удалён или хранится в другом расположении.",
    en: "The file may have been moved, deleted or stored elsewhere.",
    zh: "文件可能已被移动、删除或存放在其他位置。",
  },
  "player.linuxCodec": {
    ru: "Похоже, в системе нет кодеков для этого формата. Установите их командой:",
    en: "The system seems to lack codecs for this format. Install them with:",
    zh: "系统似乎缺少此格式的编解码器。请使用以下命令安装：",
  },
  "player.formatUnsupported": {
    ru: "Формат файла не поддерживается проигрывателем.",
    en: "The player doesn't support this file format.",
    zh: "播放器不支持此文件格式。",
  },
  "player.loading": { ru: "Загрузка…", en: "Loading…", zh: "加载中…" },

  // ── История ──────────────────────────────────────────────────────────────
  "hist.title": { ru: "История загрузок", en: "Download history", zh: "下载历史" },
  "hist.clear": { ru: "Очистить историю", en: "Clear history", zh: "清除历史" },
  "hist.empty": { ru: "История пуста.", en: "History is empty.", zh: "历史记录为空。" },
  "hist.emptyCta": { ru: "Скачать первое видео", en: "Download your first video", zh: "下载第一个视频" },
  "hist.interrupted": { ru: "Прервано", en: "Interrupted", zh: "已中断" },
  "hist.openFolder": { ru: "Открыть папку", en: "Open folder", zh: "打开文件夹" },
  "hist.play": { ru: "Воспроизвести", en: "Play", zh: "播放" },
  "hist.resume": { ru: "Продолжить загрузку", en: "Resume download", zh: "继续下载" },
  "hist.resumeShort": { ru: "Продолжить", en: "Resume", zh: "继续" },
  "hist.restart": { ru: "Скачать заново", en: "Download again", zh: "重新下载" },
  "hist.deleteRow": { ru: "Удалить запись", en: "Delete record", zh: "删除记录" },
  "hist.notFoundLibrary": { ru: "Файл не найден в Медиатеке", en: "File not found in Library", zh: "在媒体库中未找到文件" },
  "hist.notFound": { ru: "Файл не найден", en: "File not found", zh: "未找到文件" },
  "hist.cleared": { ru: "История очищена", en: "History cleared", zh: "历史已清除" },
  "hist.rowDeleted": { ru: "Запись удалена", en: "Record deleted", zh: "记录已删除" },
  "hist.resuming": { ru: "Продолжаю загрузку", en: "Resuming download", zh: "正在继续下载" },
  "hist.redownloading": { ru: "Скачиваю заново", en: "Downloading again", zh: "正在重新下载" },

  // ── Панель загрузок ──────────────────────────────────────────────────────
  "dp.downloads": { ru: "Загрузки", en: "Downloads", zh: "下载" },
  "dp.cancelTitle": { ru: "Отменить загрузку", en: "Cancel download", zh: "取消下载" },
  "dp.dismiss": { ru: "Убрать", en: "Dismiss", zh: "移除" },
  "dp.videoOf": { ru: "Видео {index} из {total}", en: "Video {index} of {total}", zh: "视频 {index} / {total}" },
  "dp.queued": { ru: "В очереди…", en: "Queued…", zh: "排队中…" },
  "dp.done": { ru: "Готово", en: "Done", zh: "完成" },
  "dp.downloaded": { ru: "Скачано: {count}", en: "Downloaded: {count}", zh: "已下载：{count}" },
  "dp.cancelled": { ru: "Отменено", en: "Cancelled", zh: "已取消" },
  "dp.error": { ru: "Ошибка", en: "Error", zh: "错误" },
  "dp.cta.cookies": { ru: "Включить куки", en: "Enable cookies", zh: "启用 Cookie" },
  "dp.cta.proxy": { ru: "Указать прокси", en: "Set proxy", zh: "设置代理" },
  "dp.cta.update": { ru: "Обновить движок", en: "Update engine", zh: "更新引擎" },
  "dp.cta.retry": { ru: "Повторить", en: "Retry", zh: "重试" },
  "dp.updated": { ru: "Движок обновлён", en: "Engine updated", zh: "引擎已更新" },

  // ── Медиатека ────────────────────────────────────────────────────────────
  "lib.title": { ru: "Медиатека", en: "Library", zh: "媒体库" },
  "lib.refresh": { ru: "Обновить", en: "Refresh", zh: "刷新" },
  "lib.openExplorer": { ru: "Открыть в проводнике", en: "Open in file manager", zh: "在文件管理器中打开" },
  "lib.folderNamePlaceholder": { ru: "Название папки", en: "Folder name", zh: "文件夹名称" },
  "lib.newFolder": { ru: "Новая папка", en: "New folder", zh: "新建文件夹" },
  "lib.all": { ru: "Все", en: "All", zh: "全部" },
  "lib.video": { ru: "Видео", en: "Video", zh: "视频" },
  "lib.audio": { ru: "Аудио", en: "Audio", zh: "音频" },
  "lib.sortDate": { ru: "Дата", en: "Date", zh: "日期" },
  "lib.sortName": { ru: "Имя", en: "Name", zh: "名称" },
  "lib.sortSize": { ru: "Размер", en: "Size", zh: "大小" },
  "lib.selected": { ru: "Выбрано: {count}", en: "Selected: {count}", zh: "已选择：{count}" },
  "lib.dragHint": { ru: "перетащите на папку для переноса", en: "drag onto a folder to move", zh: "拖到文件夹上以移动" },
  "lib.selectAll": { ru: "Выбрать все", en: "Select all", zh: "全选" },
  "lib.delete": { ru: "Удалить", en: "Delete", zh: "删除" },
  "lib.deselect": { ru: "Снять", en: "Deselect", zh: "取消选择" },
  "lib.noResults": { ru: "Ничего не найдено по запросу «{query}».", en: "No results for “{query}”.", zh: "没有找到“{query}”的结果。" },
  "lib.emptyFolder": { ru: "В этой папке пусто.", en: "This folder is empty.", zh: "此文件夹为空。" },
  "lib.emptyRoot": {
    ru: "Пусто. Скачайте видео во вкладке «Загрузчик».",
    en: "Empty. Download videos from the Downloader tab.",
    zh: "空空如也。请在“下载”标签页下载视频。",
  },
  "lib.emptyRootCta": { ru: "Вставить ссылку", en: "Paste a link", zh: "粘贴链接" },
  "lib.folder": { ru: "Папка", en: "Folder", zh: "文件夹" },
  "lib.openFolderArrow": { ru: "Открыть папку →", en: "Open folder →", zh: "打开文件夹 →" },
  "lib.rename": { ru: "Переименовать", en: "Rename", zh: "重命名" },
  "lib.setCover": { ru: "Сменить обложку", en: "Change cover", zh: "更换封面" },
  "lib.select": { ru: "Выбрать", en: "Select", zh: "选择" },
  "lib.imagesFilter": { ru: "Изображения", en: "Images", zh: "图片" },
  "lib.sh.0": { ru: "Поиск по всей библиотеке…", en: "Search the whole library…", zh: "搜索整个媒体库…" },
  "lib.sh.1": { ru: "Тот самый ролик про котиков?…", en: "That one cat video?…", zh: "那个猫咪视频？…" },
  "lib.sh.2": { ru: "Куда же я сохранил это видео…", en: "Where did I save that video…", zh: "我把那个视频存哪儿了…" },
  "lib.sh.3": { ru: "Введите название — найду вмиг 🐾", en: "Type a name — I'll find it in a flash 🐾", zh: "输入名称 — 我会立刻找到 🐾" },
  "lib.sh.4": { ru: "Мемы, лекции, музыка… что ищем?", en: "Memes, lectures, music… what are we after?", zh: "梗图、讲座、音乐… 找什么？" },
  "lib.sh.5": { ru: "Мяу? Имя файла подскажете?", en: "Meow? What's the file name?", zh: "喵？告诉我文件名？" },
  "lib.confirmDeleteVideo": { ru: "Удалить «{title}»? Файл отправится в корзину.", en: "Delete “{title}”? The file will go to the trash.", zh: "删除“{title}”？文件将移入回收站。" },
  "lib.confirmDeleteFolder": { ru: "Удалить папку «{name}» со всем содержимым в корзину?", en: "Delete folder “{name}” with all its contents to the trash?", zh: "将文件夹“{name}”及其全部内容移入回收站？" },
  "lib.confirmDeleteSelected": { ru: "Удалить выбранные видео ({count})? Файлы отправятся в корзину.", en: "Delete selected videos ({count})? The files will go to the trash.", zh: "删除选中的视频（{count}）？文件将移入回收站。" },
  "lib.coverUpdated": { ru: "Обложка обновлена", en: "Cover updated", zh: "封面已更新" },
  "lib.folderCreated": { ru: "Папка «{name}» создана", en: "Folder “{name}” created", zh: "文件夹“{name}”已创建" },
  "lib.movedMulti": { ru: "Перемещено: {count} → «{name}»", en: "Moved: {count} → “{name}”", zh: "已移动：{count} → “{name}”" },
  "lib.movedOne": { ru: "Перемещено в «{name}»", en: "Moved to “{name}”", zh: "已移动到“{name}”" },
  "lib.renamed": { ru: "Переименовано", en: "Renamed", zh: "已重命名" },
  "lib.videoDeleted": { ru: "Видео удалено", en: "Video deleted", zh: "视频已删除" },
  "lib.folderDeleted": { ru: "Папка удалена", en: "Folder deleted", zh: "文件夹已删除" },
  "lib.deletedCount": { ru: "Удалено: {count}", en: "Deleted: {count}", zh: "已删除：{count}" },
  "lib.localFile": { ru: "Локальный файл", en: "Local file", zh: "本地文件" },

  // ── Локальная сеть ───────────────────────────────────────────────────────
  "lan.title": { ru: "Рядом", en: "Nearby", zh: "附近" },
  "lan.subtitle": {
    ru: "Передавайте видео и музыку между своими устройствами без интернета и проводов — или смотрите вместе.",
    en: "Move videos and music between your devices without internet or cables — or watch together.",
    zh: "无需网络和数据线，在设备间互传视频和音乐，或一起观看。",
  },
  "lan.introTitle": { ru: "Обмен с устройствами рядом", en: "Share with devices nearby", zh: "与附近设备共享" },
  "lan.introText": {
    ru: "Компьютер и телефоны с Mestia находят друг друга сами. Файлы идут напрямую по вашей сети и никуда не загружаются.",
    en: "Computers and phones running Mestia find each other automatically. Files go directly over your network and aren't uploaded anywhere.",
    zh: "运行 Mestia 的电脑和手机会自动发现彼此。文件直接在你的网络中传输，不会上传到任何地方。",
  },
  "lan.step1": {
    ru: "Подключите устройства к одному Wi-Fi — или к точке доступа одного из телефонов.",
    en: "Connect the devices to the same Wi-Fi — or to one phone's hotspot.",
    zh: "将设备连接到同一 Wi-Fi，或连接到其中一部手机的热点。",
  },
  "lan.step2": {
    ru: "Откройте «Рядом» на каждом устройстве и нажмите «Включить».",
    en: "Open Nearby on each device and tap Turn on.",
    zh: "在每台设备上打开“附近”并点击“开启”。",
  },
  "lan.step3": {
    ru: "Выберите устройство в списке: отправьте файлы или смотрите вместе.",
    en: "Pick a device in the list: send files or watch together.",
    zh: "在列表中选择设备：发送文件或一起观看。",
  },
  "lan.turnOn": { ru: "Включить", en: "Turn on", zh: "开启" },
  "lan.turnOff": { ru: "Выключить", en: "Turn off", zh: "关闭" },
  "lan.youAre": { ru: "Другие устройства видят вас как", en: "Other devices see you as", zh: "其他设备看到的你是" },
  "lan.rename": { ru: "Переименовать устройство", en: "Rename device", zh: "重命名设备" },
  "lan.searchingTitle": { ru: "Ищем устройства рядом…", en: "Looking for devices nearby…", zh: "正在查找附近的设备…" },
  "lan.searchingText": {
    ru: "На другом устройстве откройте Mestia → «Рядом» и нажмите «Включить». Оно появится здесь через пару секунд.",
    en: "On the other device, open Mestia → Nearby and tap Turn on. It'll show up here in a couple of seconds.",
    zh: "在另一台设备上打开 Mestia →“附近”并点击“开启”，几秒后它会出现在这里。",
  },
  "lan.ready": { ru: "Готово к обмену", en: "Ready to share", zh: "可以共享" },
  "lan.roomOpen": { ru: "Сейчас смотрит «{title}» — можно присоединиться", en: "Now watching “{title}” — you can join", zh: "正在观看“{title}”，可以加入" },
  "lan.sendFiles": { ru: "Отправить файлы", en: "Send files", zh: "发送文件" },
  "lan.sending": { ru: "Отправка…", en: "Sending…", zh: "发送中…" },
  "lan.receivedFrom": { ru: "Получено от {name} · лежит в медиатеке", en: "Received from {name} · now in your library", zh: "已从 {name} 接收 · 已在媒体库中" },
  "lan.sentTo": { ru: "Отправлено на {name}", en: "Sent to {name}", zh: "已发送到 {name}" },
  "lan.helpTitle": { ru: "Не видно нужного устройства?", en: "Can't see your device?", zh: "看不到要找的设备？" },
  "lan.tipSameWifi": {
    ru: "Оба устройства должны быть в одной сети: один Wi-Fi или точка доступа телефона (мобильный интернет не нужен).",
    en: "Both devices must be on the same network: one Wi-Fi or a phone hotspot (mobile data isn't needed).",
    zh: "两台设备需在同一网络中：同一 Wi-Fi 或手机热点（无需移动数据）。",
  },
  "lan.tipBothOn": {
    ru: "На втором устройстве тоже должен быть открыт раздел «Рядом» и нажато «Включить».",
    en: "The other device also needs Nearby open and turned on.",
    zh: "另一台设备也需要打开“附近”并开启。",
  },
  "lan.tipFirewall": {
    ru: "Windows может спросить разрешение для Mestia — разрешите доступ в частных сетях.",
    en: "Windows may ask about Mestia — allow access on private networks.",
    zh: "Windows 可能会询问 Mestia 的网络权限，请允许在专用网络中访问。",
  },
  "lan.tipGuest": {
    ru: "Гостевые и общественные Wi-Fi часто не пускают устройства друг к другу — тогда раздайте сеть с телефона.",
    en: "Guest and public Wi-Fi often block devices from seeing each other — use a phone hotspot instead.",
    zh: "访客或公共 Wi-Fi 常会阻止设备互相访问，此时可改用手机热点。",
  },
  "lan.myAddress": { ru: "Адрес этого устройства:", en: "This device's address:", zh: "本设备地址：" },
  "lan.manualHint": {
    ru: "Если автоматически не находится — введите адрес, который показан на другом устройстве в этом же разделе.",
    en: "If it isn't found automatically, enter the address shown in this section on the other device.",
    zh: "如果无法自动找到，请输入另一台设备在此处显示的地址。",
  },
  "lan.manualPlaceholder": { ru: "например 192.168.1.5", en: "e.g. 192.168.1.5", zh: "例如 192.168.1.5" },
  "lan.pickSendHint": {
    ru: "Отметьте файлы — получатель увидит запрос и решит, принять ли их.",
    en: "Check the files — the recipient will see a request and decide whether to accept.",
    zh: "勾选文件，接收方会看到请求并决定是否接受。",
  },
  "lan.pickRoomHint": {
    ru: "Устройства рядом увидят комнату и смогут присоединиться. Управлять паузой и перемоткой сможет каждый.",
    en: "Nearby devices will see the room and can join. Everyone can pause and seek.",
    zh: "附近设备会看到该房间并可加入，每个人都可以暂停和跳转。",
  },
  "lan.fromComputer": { ru: "Выбрать на компьютере…", en: "Choose on computer…", zh: "从电脑选择…" },
  "lan.libraryEmpty": {
    ru: "Здесь пока пусто — скачайте что-нибудь в «Загрузчике».",
    en: "Nothing here yet — download something in Downloader.",
    zh: "这里还没有内容，请先在“下载”中下载。",
  },
  "lan.togetherHint": {
    ru: "Видео или музыка из медиатеки играет на всех устройствах одновременно: пауза и перемотка — у всех сразу. Скачивать файл гостям не нужно.",
    en: "A video or track from your library plays on all devices at once: pause and seek apply to everyone. Guests don't need to download the file.",
    zh: "媒体库中的视频或音乐在所有设备上同步播放：暂停和跳转对所有人生效，访客无需下载文件。",
  },
  "lan.createRoom": { ru: "Выбрать, что смотреть", en: "Choose what to watch", zh: "选择要看的内容" },
  "lan.devices": { ru: "Устройства", en: "Devices", zh: "设备" },
  "lan.connect": { ru: "Добавить", en: "Add", zh: "添加" },
  "lan.found": { ru: "Найдено: {name}", en: "Found: {name}", zh: "已找到：{name}" },
  "lan.sendN": { ru: "Отправить ({n})", en: "Send ({n})", zh: "发送（{n}）" },
  "lan.pickSend": { ru: "Отправить на «{name}»", en: "Send to “{name}”", zh: "发送到“{name}”" },
  "lan.pickRoom": { ru: "Что смотрим вместе?", en: "What are we watching?", zh: "一起看什么？" },
  "lan.searchLibrary": { ru: "Поиск в медиатеке", en: "Search the library", zh: "搜索媒体库" },
  "lan.waitingAnswer": { ru: "Ждём подтверждения на «{name}»…", en: "Waiting for “{name}” to accept…", zh: "等待“{name}”确认…" },
  "lan.sent": { ru: "Отправлено на «{name}»", en: "Sent to “{name}”", zh: "已发送到“{name}”" },
  "lan.received": { ru: "Получен файл «{name}» от {from}", en: "Received “{name}” from {from}", zh: "已收到来自 {from} 的“{name}”" },
  "lan.offerTitle": { ru: "{from} отправляет файлы", en: "{from} is sending files", zh: "{from} 正在发送文件" },
  "lan.offerText": {
    ru: "Файлов: {n}, всего {size}. Они сохранятся в папку загрузок.",
    en: "Files: {n}, {size} in total. They'll be saved to the download folder.",
    zh: "文件：{n} 个，共 {size}。将保存到下载文件夹。",
  },
  "lan.accept": { ru: "Принять", en: "Accept", zh: "接受" },
  "lan.decline": { ru: "Отклонить", en: "Decline", zh: "拒绝" },
  "lan.transfers": { ru: "Передачи", en: "Transfers", zh: "传输" },
  "lan.clearDone": { ru: "Убрать завершённые", en: "Clear finished", zh: "清除已完成" },
  "lan.failed": { ru: "Ошибка", en: "Failed", zh: "失败" },
  "lan.fromPeer": { ru: "от {name}", en: "from {name}", zh: "来自 {name}" },
  "lan.toPeer": { ru: "на {name}", en: "to {name}", zh: "发往 {name}" },
  "lan.together": { ru: "Смотреть вместе", en: "Watch together", zh: "一起观看" },
  "lan.join": { ru: "Присоединиться", en: "Join", zh: "加入" },
  "room.hostAlone": { ru: "Вы ведущий · ждём участников", en: "You're hosting · waiting for others", zh: "你是主持人 · 等待其他人" },
  "room.hostWith": { ru: "Вы ведущий · смотрят: {names}", en: "You're hosting · watching: {names}", zh: "你是主持人 · 观看者：{names}" },
  "room.guestOf": { ru: "Ведущий: {host} · в комнате: {n}", en: "Host: {host} · in the room: {n}", zh: "主持人：{host} · 房间人数：{n}" },
  "room.close": { ru: "Закрыть комнату", en: "Close room", zh: "关闭房间" },
  "room.leave": { ru: "Выйти из комнаты", en: "Leave room", zh: "离开房间" },
  "room.ended": { ru: "Ведущий закрыл комнату", en: "The host closed the room", zh: "主持人已关闭房间" },
  "room.syncing": { ru: "Синхронизация…", en: "Syncing…", zh: "同步中…" },
  "room.tapToJoin": { ru: "Нажмите, чтобы включить звук и видео", en: "Tap to start playback", zh: "点击开始播放" },
  "room.queue": { ru: "Очередь", en: "Queue", zh: "播放队列" },
  "room.add": { ru: "Добавить", en: "Add", zh: "添加" },
  "room.propose": { ru: "Предложить", en: "Suggest", zh: "推荐" },
  "room.addTitle": { ru: "Добавить в очередь", en: "Add to queue", zh: "添加到队列" },
  "room.proposeTitle": { ru: "Предложить в очередь", en: "Suggest for the queue", zh: "推荐到队列" },
  "room.addHint": {
    ru: "Файлы встанут в конец очереди. Порядок можно поменять стрелками.",
    en: "Files go to the end of the queue. Reorder them with the arrows.",
    zh: "文件将加入队列末尾，可用箭头调整顺序。",
  },
  "room.proposeHint": {
    ru: "Файлы появятся в очереди у всех и будут играть прямо с вашего устройства — не выходите из комнаты, пока они не доиграют.",
    en: "Files appear in everyone's queue and play straight from your device — stay in the room until they finish.",
    zh: "文件会出现在所有人的队列中，并直接从你的设备播放——播放完之前请不要离开房间。",
  },
  "room.addN": { ru: "Добавить ({n})", en: "Add ({n})", zh: "添加（{n}）" },
  "room.proposeN": { ru: "Предложить ({n})", en: "Suggest ({n})", zh: "推荐（{n}）" },
  "room.proposed": { ru: "Добавлено в очередь: {n}", en: "Added to the queue: {n}", zh: "已加入队列：{n}" },
  "room.proposedBy": { ru: "предложил(а) {name}", en: "suggested by {name}", zh: "{name} 推荐" },
  "room.next": { ru: "Следующий", en: "Next", zh: "下一个" },
  "room.playNow": { ru: "Включить сейчас", en: "Play now", zh: "立即播放" },
  "room.up": { ru: "Выше", en: "Move up", zh: "上移" },
  "room.down": { ru: "Ниже", en: "Move down", zh: "下移" },
  "room.remove": { ru: "Убрать из очереди", en: "Remove from queue", zh: "从队列移除" },
  "room.queueEndHost": {
    ru: "Это последний файл. Добавьте ещё — следующий включится у всех автоматически.",
    en: "This is the last file. Add more — the next one starts for everyone automatically.",
    zh: "这是最后一个文件。继续添加，下一个会自动为所有人播放。",
  },
  "room.queueEndGuest": {
    ru: "Дальше ничего нет — предложите что-нибудь своё.",
    en: "Nothing up next — suggest something of yours.",
    zh: "后面没有内容了——推荐点你的吧。",
  },
  "room.toQueue": { ru: "В очередь", en: "To queue", zh: "加入队列" },
  "room.minimize": { ru: "Свернуть комнату", en: "Minimize room", zh: "收起房间" },
  "room.expand": { ru: "Вернуться в комнату", en: "Back to the room", zh: "返回房间" },
  "room.minimizedHost": { ru: "Комната открыта · вы ведущий", en: "Room open · you're hosting", zh: "房间已开启 · 你是主持人" },
  "room.minimizedGuest": { ru: "В комнате у {host}", en: "In {host}'s room", zh: "在 {host} 的房间中" },
  "lan.send": { ru: "Отправить", en: "Send", zh: "发送" },
  "lan.sendToTitle": { ru: "Отправить на устройство", en: "Send to a device", zh: "发送到设备" },
  "lan.sendToSummary": { ru: "Файлов: {n} · {size}", en: "Files: {n} · {size}", zh: "文件：{n} · {size}" },
  "lan.sendToOff": {
    ru: "Чтобы отправлять файлы, включите «Рядом» — устройства в вашей сети появятся здесь.",
    en: "Turn on Nearby to send files — devices on your network will show up here.",
    zh: "开启“附近”即可发送文件，你网络中的设备会显示在这里。",
  },
  "pick.all": { ru: "Все", en: "All", zh: "全部" },
  "pick.video": { ru: "Видео", en: "Video", zh: "视频" },
  "pick.audio": { ru: "Музыка", en: "Music", zh: "音乐" },
  "pick.allFolders": { ru: "Все папки", en: "All folders", zh: "所有文件夹" },
  "pick.rootFolder": { ru: "Без папки", en: "No folder", zh: "无文件夹" },
  "pick.sortNew": { ru: "Сначала новые", en: "Newest first", zh: "最新优先" },
  "pick.sortName": { ru: "По названию", en: "By name", zh: "按名称" },
  "pick.selectShown": { ru: "Выбрать все показанные ({n})", en: "Select all shown ({n})", zh: "全选当前显示（{n}）" },
  "pick.unselectShown": { ru: "Снять выбор с показанных ({n})", en: "Unselect shown ({n})", zh: "取消选择当前显示（{n}）" },
  "pick.selected": { ru: "Выбрано: {n} · {size}", en: "Selected: {n} · {size}", zh: "已选：{n} · {size}" },
  "pick.noneSelected": { ru: "Ничего не выбрано", en: "Nothing selected", zh: "未选择" },
  "pick.nothingFound": { ru: "По этому фильтру ничего нет", en: "Nothing matches this filter", zh: "没有符合筛选条件的内容" },
  "pick.limited": {
    ru: "Показаны первые {n} из {total} — уточните поиск или фильтр",
    en: "Showing the first {n} of {total} — refine the search or filter",
    zh: "仅显示 {total} 个中的前 {n} 个，请细化搜索或筛选",
  },
  "room.mediaError": { ru: "Не удалось воспроизвести файл комнаты", en: "Couldn't play the room's file", zh: "无法播放房间文件" },

  // ── Настройки ────────────────────────────────────────────────────────────
  "set.title": { ru: "Настройки", en: "Settings", zh: "设置" },
  "set.downloadFolder": { ru: "Папка загрузок", en: "Download folder", zh: "下载文件夹" },
  "set.folderBusy": { ru: "Смена папки недоступна, пока идут загрузки.", en: "Can't change the folder while downloads are running.", zh: "下载进行时无法更改文件夹。" },
  "set.folderAndroid": {
    ru: "Уже скачанные файлы переносятся в новую папку. Видео и музыка видны в «Файлах», галерее и плеерах.",
    en: "Already downloaded files are moved to the new folder. Videos and music are visible in Files, the gallery and players.",
    zh: "已下载的文件会移动到新文件夹。视频和音乐可在“文件”、相册和播放器中查看。",
  },
  "set.folderMoving": { ru: "Перенос…", en: "Moving…", zh: "正在移动…" },
  "set.folderMoved": { ru: "Папка изменена, перенесено файлов: {n}", en: "Folder changed, files moved: {n}", zh: "文件夹已更改，已移动 {n} 个文件" },
  "set.folderMovedPartial": {
    ru: "Папка изменена, но {n} файл(ов) перенести не удалось — они остались в прежней папке.",
    en: "Folder changed, but {n} file(s) couldn't be moved — they stayed in the old folder.",
    zh: "文件夹已更改，但有 {n} 个文件无法移动，仍留在原文件夹中。",
  },
  "set.advanced": { ru: "Расширенные настройки", en: "Advanced settings", zh: "高级设置" },
  "set.folderApplies": {
    ru: "Применяется к новым загрузкам. Уже скачанные файлы не переносятся.",
    en: "Applies to new downloads. Already downloaded files are not moved.",
    zh: "适用于新的下载。已下载的文件不会被移动。",
  },
  "set.parallel": { ru: "Одновременных загрузок", en: "Simultaneous downloads", zh: "同时下载数" },
  "set.parallelHint": { ru: "Остальные задачи становятся в очередь.", en: "Other tasks go into a queue.", zh: "其余任务将进入队列。" },
  "set.speed": { ru: "Скорость загрузки", en: "Download speed", zh: "下载速度" },
  "set.speedNormal": { ru: "Обычная", en: "Normal", zh: "普通" },
  "set.speedFast": { ru: "Быстрая", en: "Fast", zh: "快速" },
  "set.speedMax": { ru: "Максимум", en: "Maximum", zh: "最高" },
  "set.speedHint": {
    ru: "Сколько фрагментов качать параллельно. Выше — быстрее, но больше нагрузка на сеть и диск.",
    en: "How many fragments to download in parallel. Higher is faster but puts more load on network and disk.",
    zh: "并行下载的分片数量。越高越快，但对网络和磁盘的负载也越大。",
  },
  "set.skip": { ru: "Шаг перемотки в плеере", en: "Seek step in the player", zh: "播放器快进步长" },
  "set.skipHint": {
    ru: "На сколько перематывают стрелки ←/→ и кнопки в плеере.",
    en: "How far the ←/→ arrows and player buttons seek.",
    zh: "播放器中 ←/→ 箭头和按钮每次快进/快退的时长。",
  },
  "set.notifications": { ru: "Уведомления на рабочий стол", en: "Desktop notifications", zh: "桌面通知" },
  "set.test": { ru: "Проверить", en: "Test", zh: "测试" },
  "set.notificationsHint": {
    ru: "Сообщать о завершении загрузки, даже когда окно свёрнуто. На Windows всплывающие уведомления видны только в установленной версии и при выключенном режиме «Не беспокоить».",
    en: "Notify when a download finishes even if the window is minimized. On Windows pop-ups appear only in the installed version and with “Do not disturb” off.",
    zh: "即使窗口最小化，也在下载完成时通知。在 Windows 上，弹出通知仅在已安装版本且关闭“勿扰模式”时可见。",
  },
  "set.cookies": { ru: "Куки из браузера", en: "Cookies from browser", zh: "浏览器 Cookie" },
  "set.cookiesOff": { ru: "Выключено", en: "Off", zh: "关闭" },
  "set.cookiesHint": {
    ru: "Нужно для приватных, возрастных и доступных по подписке видео. Браузер при скачивании лучше закрыть.",
    en: "Needed for private, age-restricted and subscription videos. Better close the browser while downloading.",
    zh: "用于私密、年龄限制和订阅视频。下载时最好关闭浏览器。",
  },
  "set.proxy": { ru: "Прокси", en: "Proxy", zh: "代理" },
  "set.proxyPlaceholder": { ru: "http://host:port или socks5://host:port", en: "http://host:port or socks5://host:port", zh: "http://host:port 或 socks5://host:port" },
  "set.proxyHint": {
    ru: "Необязательно. Помогает с контентом, недоступным в вашем регионе. Свой сервер вписываете сами — ответственность за использование на вас.",
    en: "Optional. Helps with content unavailable in your region. You enter your own server — you're responsible for its use.",
    zh: "可选。有助于访问你所在地区不可用的内容。需自行填写服务器 — 使用责任自负。",
  },
  "set.subtitles": { ru: "Скачивать субтитры", en: "Download subtitles", zh: "下载字幕" },
  "set.subtitlesPlaceholder": { ru: "ru,en или all", en: "ru,en or all", zh: "ru,en 或 all" },
  "set.subtitlesHint": {
    ru: "Встраиваются в видео. Языки через запятую (или «all» — все доступные).",
    en: "Embedded into the video. Languages comma-separated (or “all” for every available).",
    zh: "嵌入视频中。语言以逗号分隔（或用“all”表示全部可用）。",
  },
  "set.sponsorblock": { ru: "Вырезать спонсорские вставки", en: "Cut out sponsor segments", zh: "剪除赞助片段" },
  "set.sponsorblockHint": {
    ru: "SponsorBlock удаляет спонсорские сегменты и интро (по базе сообщества).",
    en: "SponsorBlock removes sponsor segments and intros (from the community database).",
    zh: "SponsorBlock 会移除赞助片段和开场（基于社区数据库）。",
  },
  "set.engine": { ru: "Движок yt-dlp", en: "yt-dlp engine", zh: "yt-dlp 引擎" },
  "set.update": { ru: "Обновить", en: "Update", zh: "更新" },
  "set.engineHint": {
    ru: "Если какой-то сайт перестал работать — обновите движок.",
    en: "If some site stopped working — update the engine.",
    zh: "如果某个网站无法使用 — 请更新引擎。",
  },
  "set.theme": { ru: "Тема оформления", en: "Theme", zh: "主题" },
  "set.themeHint": { ru: "Верхний ряд — светлые, нижний — тёмные.", en: "Top row is light, bottom is dark.", zh: "上排为浅色，下排为深色。" },
  "set.iconHint": {
    ru: "Иконка окна, панели задач и трея меняется вместе с темой.",
    en: "The window, taskbar and tray icon follow the theme.",
    zh: "窗口、任务栏和托盘图标随主题变化。",
  },
  "set.iconHintAndroid": {
    ru: "Иконка на рабочем столе сменится, когда вы выйдете из приложения.",
    en: "The home screen icon updates once you leave the app.",
    zh: "退出应用后，桌面图标会随之更新。",
  },
  "set.language": { ru: "Язык", en: "Language", zh: "语言" },
  "set.languageHint": { ru: "Язык интерфейса приложения.", en: "Application interface language.", zh: "应用界面语言。" },
  "set.uninstall": { ru: "Удалить приложение", en: "Uninstall app", zh: "卸载应用" },
  "set.uninstallHint": { ru: "Сотрёт данные приложения и запустит деинсталляцию.", en: "Erases app data and starts uninstallation.", zh: "将清除应用数据并启动卸载。" },
  "set.uninstallTitle": { ru: "Удалить Mestia?", en: "Uninstall Mestia?", zh: "卸载 Mestia？" },
  "set.uninstallText": {
    ru: "Будут стёрты данные приложения (история, медиатека, настройки) и запущена деинсталляция. Действие необратимо.",
    en: "App data (history, library, settings) will be erased and uninstallation will start. This can't be undone.",
    zh: "将清除应用数据（历史、媒体库、设置）并启动卸载。此操作不可撤销。",
  },
  "set.alsoDeleteFiles": { ru: "Также удалить скачанные файлы", en: "Also delete downloaded files", zh: "同时删除已下载的文件" },
  "set.alsoDeleteFilesHint": {
    ru: "Папка загрузок со всем видео/аудио. Иначе файлы останутся на диске.",
    en: "The download folder with all video/audio. Otherwise files stay on disk.",
    zh: "包含所有视频/音频的下载文件夹。否则文件将保留在磁盘上。",
  },
  "set.folderUpdated": { ru: "Папка загрузок обновлена", en: "Download folder updated", zh: "下载文件夹已更新" },
  "set.notifDenied": { ru: "Уведомления запрещены в системе", en: "Notifications are blocked by the system", zh: "系统已禁止通知" },
  "set.notifWorks": { ru: "Уведомления работают 🎉", en: "Notifications work 🎉", zh: "通知正常工作 🎉" },
  "set.notifSendFail": { ru: "Не удалось отправить уведомление: {err}", en: "Couldn't send notification: {err}", zh: "无法发送通知：{err}" },
  "set.updateFail": { ru: "Не удалось обновить: {err}", en: "Update failed: {err}", zh: "更新失败：{err}" },
  "set.uninstallFail": { ru: "Не удалось удалить: {err}", en: "Uninstall failed: {err}", zh: "卸载失败：{err}" },

  // ── Окно обновления приложения ───────────────────────────────────────────
  "upd.title": { ru: "Доступно обновление", en: "Update available", zh: "有可用更新" },
  "upd.newVersionYou": {
    ru: "Новая версия v{version} (у вас v{current}). Обновить сейчас?",
    en: "New version v{version} (you have v{current}). Update now?",
    zh: "新版本 v{version}（当前 v{current}）。现在更新吗？",
  },
  "upd.newVersion": { ru: "Новая версия v{version}. Обновить сейчас?", en: "New version v{version}. Update now?", zh: "新版本 v{version}。现在更新吗？" },
  "upd.installFail": { ru: "Не удалось установить обновление.", en: "Couldn't install the update.", zh: "无法安装更新。" },
  "upd.downloading": { ru: "Загрузка обновления…", en: "Downloading update…", zh: "正在下载更新…" },
  "upd.downloadingPct": { ru: "Загрузка… {pct}%", en: "Downloading… {pct}%", zh: "下载中… {pct}%" },
  "upd.retry": { ru: "Попробовать снова", en: "Try again", zh: "重试" },
  "upd.updateRestart": { ru: "Обновить и перезапустить", en: "Update and restart", zh: "更新并重启" },
  "upd.later": { ru: "Позже", en: "Later", zh: "稍后" },

  // ── Диалог закрытия ──────────────────────────────────────────────────────
  "app.closeTitle": { ru: "Закрыть Mestia?", en: "Close Mestia?", zh: "关闭 Mestia？" },
  "app.closeText": { ru: "Свернуть в трей или выйти полностью?", en: "Minimize to tray or quit completely?", zh: "最小化到托盘还是完全退出？" },
  "app.tray": { ru: "Свернуть в трей", en: "Minimize to tray", zh: "最小化到托盘" },
  "app.exit": { ru: "Выйти", en: "Quit", zh: "退出" },

  // ── Контекст загрузок (тосты, уведомления) ───────────────────────────────
  "toast.done": { ru: "Готово: {title}", en: "Done: {title}", zh: "完成：{title}" },
  "toast.doneDesktop": { ru: "Mestia — загрузка завершена", en: "Mestia — download finished", zh: "Mestia — 下载完成" },
  "toast.error": { ru: "Ошибка: {title}", en: "Error: {title}", zh: "错误：{title}" },
  "toast.authHint": {
    ru: " · нужен вход — включите куки в настройках",
    en: " · sign-in needed — enable cookies in settings",
    zh: " · 需要登录 — 请在设置中启用 Cookie",
  },
  "toast.errorDesktop": { ru: "Mestia — ошибка загрузки", en: "Mestia — download error", zh: "Mestia — 下载错误" },
  "toast.startError": { ru: "Ошибка запуска загрузки", en: "Failed to start download", zh: "启动下载失败" },
  "toast.cancelled": { ru: "Загрузка отменена", en: "Download cancelled", zh: "下载已取消" },
  "ctx.playlistPrefix": { ru: "Плейлист: {title}", en: "Playlist: {title}", zh: "播放列表：{title}" },
  "ctx.downloadFallback": { ru: "Загрузка", en: "Download", zh: "下载" },

  // ── Темы (суффикс к названию) ────────────────────────────────────────────
  "theme.light": { ru: "светлая", en: "light", zh: "浅色" },
  "theme.dark": { ru: "тёмная", en: "dark", zh: "深色" },
  "theme.neutralLight": { ru: "нейтральная светлая", en: "neutral light", zh: "中性浅色" },
  "theme.neutralDark": { ru: "нейтральная тёмная", en: "neutral dark", zh: "中性深色" },

  // ── Форматы (переводимая часть подписи) ──────────────────────────────────
  "fmt.best": { ru: "Лучшее качество", en: "Best quality", zh: "最佳画质" },
  "fmt.audioBest": { ru: "Оригинал", en: "Original", zh: "原始音质" },
  "fmt.lossless": { ru: "без потерь", en: "lossless", zh: "无损" },

  // ── Ошибки (humanizeError) ───────────────────────────────────────────────
  "err.generic": { ru: "Что-то пошло не так. Попробуйте ещё раз.", en: "Something went wrong. Please try again.", zh: "出了点问题。请重试。" },
  "err.drm": { ru: "Контент защищён (DRM) — скачивание невозможно.", en: "Content is DRM-protected — download isn't possible.", zh: "内容受 DRM 保护 — 无法下载。" },
  "err.auth": { ru: "Нужен вход в аккаунт. Включите «Куки из браузера» в настройках.", en: "Sign-in required. Enable “Cookies from browser” in settings.", zh: "需要登录账户。请在设置中启用“浏览器 Cookie”。" },
  "err.network": { ru: "Проблема с сетью. Проверьте подключение к интернету и попробуйте снова.", en: "Network problem. Check your internet connection and try again.", zh: "网络故障。请检查网络连接后重试。" },
  "err.disk": { ru: "На диске закончилось место. Освободите место и попробуйте снова.", en: "Out of disk space. Free up space and try again.", zh: "磁盘空间不足。请释放空间后重试。" },
  "err.busy": { ru: "Файл занят другой программой. Закройте её (например, плеер) и повторите.", en: "The file is in use by another program. Close it (e.g. a player) and retry.", zh: "文件正被其他程序占用。请关闭它（例如播放器）后重试。" },
  "err.access": { ru: "Нет доступа к файлу или папке. Проверьте права доступа.", en: "No access to the file or folder. Check permissions.", zh: "无法访问文件或文件夹。请检查权限。" },
  "err.notfound": { ru: "Файл или папка не найдены.", en: "File or folder not found.", zh: "未找到文件或文件夹。" },
  "err.unavailable": { ru: "Видео недоступно — возможно, удалено или закрыто автором.", en: "Video is unavailable — possibly removed or restricted by the author.", zh: "视频不可用 — 可能已被作者删除或设为私有。" },
  "err.geo": { ru: "Контент недоступен в вашем регионе.", en: "Content isn't available in your region.", zh: "内容在你所在的地区不可用。" },
  "err.unsupported": { ru: "Не удалось распознать ссылку. Проверьте, что она ведёт на видео или трек.", en: "Couldn't recognize the link. Make sure it points to a video or track.", zh: "无法识别该链接。请确认它指向视频或曲目。" },
};

/** Перевод для явно заданного языка (используется React-хуком). */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const entry = DICT[key];
  const s = entry ? entry[lang] ?? entry.ru : key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

/** Перевод по активному языку модуля — для не-React кода (humanizeError и т.п.). */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(active, key, params);
}
