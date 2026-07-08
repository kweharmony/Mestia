import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronDown,
  Clipboard,
  Cookie,
  ListVideo,
  Loader2,
  Music,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Video,
  X,
} from "lucide-react";
import {
  AUDIO_FORMATS,
  DEFAULT_VIDEO_FORMAT,
  VIDEO_FORMATS,
  estimateAudioBytes,
  existingPaths,
  fetchMetadata,
  formatBytes,
  formatDuration,
  formatLabel,
  getSetting,
  humanizeError,
  isAuthError,
} from "../lib/ipc";
import { findVideoByUrl } from "../lib/db";
import type { DownloadFormat, FetchResult, FormatSizes } from "../types";
import { useToast } from "../components/Toast";
import Modal from "../components/Modal";
import { useDownloads } from "../context/DownloadsContext";
import { useI18n } from "../context/LanguageContext";
import Typewriter from "../components/Typewriter";

type Phase = "idle" | "fetching" | "ready";
type PlMode = "all" | "range";

// Порог, выше которого «Скачать весь плейлист» просит подтверждения — чтобы
// случайная ссылка на канал/огромный плейлист не запустила лавину загрузок.
const BIG_PLAYLIST = 40;

// Разумный видеопресет по умолчанию для источника максимальной высотой max:
// предпочитаем 1080p, если оно есть; иначе — лучшее доступное конкретное разрешение,
// а для совсем низких — «Лучшее качество». max=null (высота неизвестна) → 1080p.
function defaultVideoFor(max: number | null): DownloadFormat {
  if (max == null || max >= 900) return DEFAULT_VIDEO_FORMAT;
  return (
    VIDEO_FORMATS.find((f) => f.minHeight && max >= f.minHeight) ??
    VIDEO_FORMATS.find((f) => !f.minHeight) ??
    DEFAULT_VIDEO_FORMAT
  );
}

// Сервисы без прямой поддержки yt-dlp — качаем аналог с YouTube по названию.
const SERVICE_LABELS: Record<string, string> = {
  spotify: "Spotify",
  apple: "Apple Music",
  vk: "VK Музыка",
  zvuk: "Звук",
};

const PLACEHOLDER_KEYS = ["dl.ph.0", "dl.ph.1", "dl.ph.2", "dl.ph.3", "dl.ph.4", "dl.ph.5"];

export default function Downloader({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { notify } = useToast();
  const { start } = useDownloads();
  const { t } = useI18n();

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<FetchResult | null>(null);
  const [mediaKind, setMediaKind] = useState<"video" | "audio">("video");
  const [fmt, setFmt] = useState<DownloadFormat>(DEFAULT_VIDEO_FORMAT);
  // Раскрыт ли полный список форматов (по умолчанию скрыт за «Настроить»).
  const [showFormats, setShowFormats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [plMode, setPlMode] = useState<PlMode>("all");
  const [range, setRange] = useState("");
  // Имя папки для плейлиста — предзаполняется названием плейлиста, редактируется пользователем.
  const [folderName, setFolderName] = useState("");
  // Видео уже в медиатеке — модалка подтверждения повторной загрузки.
  const [dup, setDup] = useState<{ title: string; onConfirm: () => void } | null>(null);
  // Большой плейлист — подтверждение перед массовой загрузкой.
  const [bigWarn, setBigWarn] = useState<{ count: number; onConfirm: () => void } | null>(null);
  // Сервис без прямой поддержки (Spotify/Apple/VK/Звук) — ручной поиск по названию.
  const [manual, setManual] = useState<string | null>(null);
  const [manualQuery, setManualQuery] = useState("");
  // Если трек найден через поиск — качаем именно его (ytsearch1:…), а не исходную ссылку.
  const [searchUrl, setSearchUrl] = useState<string | null>(null);
  // Подсказка про куки, когда ошибка похожа на «нужен вход» (cookiesOn — включены ли куки).
  const [authHint, setAuthHint] = useState<{ cookiesOn: boolean; detail: string } | null>(null);
  // Ссылка из буфера обмена — предложение вставить в один клик.
  const [clipHint, setClipHint] = useState<string | null>(null);
  // Отклонённая пользователем ссылка из буфера — больше не предлагаем её.
  const dismissedClip = useRef<string | null>(null);

  // Считываем буфер обмена при запуске и при возврате фокуса на окно: если там
  // ссылка — ненавязчиво предлагаем вставить. Доступа может не быть — тихо игнорируем.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const check = async () => {
      try {
        const txt = (await readText())?.trim();
        if (txt && looksLikeUrl(txt) && txt !== dismissedClip.current) setClipHint(txt);
        else setClipHint(null);
      } catch {
        /* нет доступа к буферу — молча */
      }
    };
    void check();
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void check();
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Вставить предложенную из буфера ссылку и сразу получить по ней данные.
  function acceptClip() {
    if (!clipHint) return;
    const c = clipHint;
    setClipHint(null);
    setUrl(c);
    void doFetch(looksLikeUrl(c) ? c : `ytsearch1:${c}`);
  }

  function reset() {
    setInfo(null);
    setUrl("");
    setError(null);
    setPhase("idle");
    setRange("");
    setPlMode("all");
    setShowFormats(false);
    setFolderName("");
    setManual(null);
    setManualQuery("");
    setSearchUrl(null);
    setAuthHint(null);
    setBigWarn(null);
  }

  function handleUrlChange(v: string) {
    setUrl(v);
    if (info || manual || searchUrl || authHint || phase !== "idle") {
      setInfo(null);
      setError(null);
      setPhase("idle");
      setManual(null);
      setSearchUrl(null);
      setAuthHint(null);
    }
  }

  // Единый разбор ошибки получения метаданных: ошибки доступа → подсказка про
  // куки, остальное → обычное сообщение.
  async function reportFetchError(msg: string) {
    if (isAuthError(msg)) {
      const c = await getSetting("cookiesBrowser").catch(() => null);
      setError(null);
      setAuthHint({ cookiesOn: !!(c && c.trim()), detail: msg });
      return;
    }
    setError(humanizeError(msg));
    notify(t("dl.fetchError"), "error");
  }

  // Ссылка это или текст для поиска: схема/домен → ссылка; иначе — поиск по названию.
  function looksLikeUrl(s: string): boolean {
    if (/^(https?:\/\/|ytsearch|scsearch|spotify:)/i.test(s)) return true;
    return !/\s/.test(s) && /\.[a-z]{2,}(\/|$|\?)/i.test(s);
  }

  async function handleFetch() {
    const t = url.trim();
    if (!t) return;
    // Не похоже на ссылку → ищем по названию на YouTube (удобно вставлять «Автор — Трек»).
    await doFetch(looksLikeUrl(t) ? t : `ytsearch1:${t}`);
  }

  async function doFetch(trimmed: string) {
    if (!trimmed) return;
    setError(null);
    setInfo(null);
    setManual(null);
    setSearchUrl(null);
    setAuthHint(null);
    setPhase("fetching");
    try {
      const r = await fetchMetadata(trimmed);
      setInfo(r);
      // Для плейлиста предзаполняем имя папки его названием (пользователь может изменить).
      setFolderName(r.is_playlist ? r.title : "");
      // Точная ссылка найденного видео (Spotify/Apple/поиск) — качаем ровно её, без
      // повторного резолва в бэкенде.
      setSearchUrl(r.resolved_url ?? null);
      // Если выбранного разрешения нет в этом видео — подбираем корректный пресет.
      if (!fmt.isAudio) {
        const max = r.sizes?.max_height ?? null;
        const ok = !fmt.minHeight || max == null || max >= fmt.minHeight;
        if (!ok) setFmt(defaultVideoFor(max));
      }
      setPlMode("all");
      setRange("");
      setPhase("ready");
    } catch (e) {
      const msg = String(e);
      // Сервис без прямой поддержки — предлагаем найти трек на YouTube по названию.
      if (msg.startsWith("MANUAL_QUERY:")) {
        setManual(msg.slice("MANUAL_QUERY:".length) || "");
        setManualQuery("");
        setPhase("idle");
        return;
      }
      setPhase("idle");
      await reportFetchError(msg);
    }
  }

  // Поиск трека на YouTube по введённому вручную «Исполнитель — Название».
  async function handleManualSearch() {
    const q = manualQuery.trim();
    if (!q) return;
    const su = `ytsearch1:${q}`;
    setError(null);
    setAuthHint(null);
    setPhase("fetching");
    try {
      const r = await fetchMetadata(su);
      setInfo(r);
      setFolderName(r.is_playlist ? r.title : "");
      // Предпочитаем точную ссылку найденного видео; иначе — сам поисковый запрос.
      setSearchUrl(r.resolved_url ?? su);
      setManual(null);
      setPlMode("all");
      setRange("");
      setPhase("ready");
    } catch (e) {
      setPhase("idle");
      await reportFetchError(String(e));
    }
  }

  // id настоящего плейлиста из ссылки на видео (RD…/миксы игнорируем — они не плейлисты).
  function playlistIdFromUrl(u: string): string | null {
    const id = u.match(/[?&]list=([^&]+)/)?.[1] ?? null;
    return id && !/^RD/i.test(id) ? id : null;
  }

  // Переоткрыть текущую ссылку как плейлист (когда видео несёт и список).
  function openAsPlaylist(listId: string) {
    const plUrl = `https://www.youtube.com/playlist?list=${listId}`;
    setUrl(plUrl);
    void doFetch(plUrl);
  }

  function pickKind(kind: "video" | "audio") {
    setMediaKind(kind);
    setFmt(kind === "video" ? defaultVideoFor(info?.sizes?.max_height ?? null) : AUDIO_FORMATS[0]);
    setShowFormats(false); // снова сворачиваем к «Авто» при смене типа
  }

  async function handleDownload() {
    if (!info) return;
    const isPlaylist = info.is_playlist;
    const mode: "single" | "all" | "range" = isPlaylist ? plMode : "single";
    const items = mode === "range" ? range.trim() : null;
    if (mode === "range" && !items) {
      notify(t("dl.rangeNeeded"), "error");
      return;
    }

    // Запуск в фоне — можно сразу искать следующее. recovery="restart"
    // перезаписывает существующий файл (для повторного скачивания).
    const launch = (recovery?: "restart") => {
      void start({
        url: searchUrl ?? url.trim(),
        format: fmt.format,
        isAudio: fmt.isAudio,
        audioFormat: fmt.isAudio ? fmt.ext : null,
        mode,
        items,
        recovery,
        meta: {
          // Для плейлиста имя папки берём из редактируемого поля (или названия плейлиста).
          title: isPlaylist ? folderName.trim() || info.title : info.title,
          platform: info.platform,
          webpage_url: info.webpage_url,
          isPlaylist,
        },
      });
      notify(isPlaylist ? t("dl.playlistAdded") : t("dl.added"));
      reset();
    };

    // Предохранитель: очень большой плейлист/канал — подтверждаем перед лавиной.
    if (isPlaylist && mode === "all" && (info.playlist_count ?? 0) > BIG_PLAYLIST) {
      setBigWarn({ count: info.playlist_count ?? 0, onConfirm: () => launch() });
      return;
    }

    // Конфликт: одиночное видео уже есть в медиатеке (и файл на месте).
    if (!isPlaylist && info.webpage_url) {
      try {
        const existing = await findVideoByUrl(info.webpage_url);
        if (existing) {
          const [onDisk] = await existingPaths([existing.file_path]);
          if (onDisk) {
            setDup({ title: existing.title, onConfirm: () => launch("restart") });
            return;
          }
        }
      } catch {
        /* проверка дубликата необязательна — не блокируем загрузку */
      }
    }

    launch();
  }

  const formats = mediaKind === "video" ? VIDEO_FORMATS : AUDIO_FORMATS;
  const isPlaylist = info?.is_playlist ?? false;
  // Ссылка на одиночное видео, которая при этом несёт настоящий плейлист.
  const alsoPlaylistId = info && !isPlaylist ? playlistIdFromUrl(url) : null;

  // Подпись с прикидкой размера для чипа формата (пусто, если неизвестно).
  function sizeLabel(f: DownloadFormat): string {
    if (f.isAudio) {
      const b = estimateAudioBytes(info?.duration, f.id);
      return b ? `~${formatBytes(b)}` : "";
    }
    const s = info?.sizes ? info.sizes[f.id as keyof FormatSizes] : null;
    return s ? formatBytes(s) : "";
  }

  return (
    <div className="mestia-fade-in flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex w-full max-w-[700px] -translate-y-[6vh] flex-col items-center gap-8">
        <h1 className="text-2xl font-normal tracking-tight">{t("dl.title")}</h1>

        {/* Строка ввода: только поле + анимированная стрелка */}
        <div className="group relative flex w-full items-center rounded-ui border-2 border-fog bg-snow p-2 pl-5 transition-colors focus-within:border-accent">
          <input
            type="text"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => e.key === "Enter" && handleFetch()}
            placeholder=""
            className="flex-1 border-none bg-transparent px-0 py-2 font-semibold text-ink outline-none"
          />
          {!url && !focused && (
            <div className="pointer-events-none absolute inset-y-0 left-5 right-14 flex items-center overflow-hidden font-semibold text-smoke">
              <Typewriter phrases={PLACEHOLDER_KEYS.map((k) => t(k))} className="whitespace-nowrap" />
            </div>
          )}
          <button
            onClick={handleFetch}
            disabled={phase === "fetching"}
            aria-label={t("dl.check")}
            className="mestia-go flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-ui bg-accent text-white transition-all hover:opacity-90 active:scale-90 disabled:opacity-50"
          >
            <AnimatePresence mode="wait" initial={false}>
              {phase === "fetching" ? (
                <motion.span
                  key="spin"
                  className="mestia-anim"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.15 }}
                >
                  <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.5} />
                </motion.span>
              ) : (
                <motion.span
                  key="go"
                  className="mestia-anim"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.15 }}
                >
                  <ArrowRight className="h-5 w-5" strokeWidth={2.75} />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>

        {/* Ссылка из буфера — предложение вставить в один клик */}
        <AnimatePresence>
          {clipHint && !url && phase === "idle" && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="mestia-anim flex w-full items-center gap-2 rounded-ui border-2 border-fog bg-paper/40 py-1.5 pl-3 pr-2"
            >
              <button
                onClick={acceptClip}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-ink"
              >
                <Clipboard className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.25} />
                <span className="shrink-0 text-smoke">{t("dl.pasteDetected")}:</span>
                <span className="truncate text-accent">{clipHint}</span>
              </button>
              <button
                onClick={() => {
                  dismissedClip.current = clipHint;
                  setClipHint(null);
                }}
                aria-label={t("common.cancel")}
                className="shrink-0 rounded-ui p-1 text-smoke hover:bg-fog hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={2.25} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Ошибка */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="mestia-anim w-full rounded-ui border-2 border-rose-400 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Подсказка про куки: ошибка похожа на «нужен вход» */}
        <AnimatePresence>
          {authHint && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="mestia-anim w-full space-y-3 rounded-ui border-2 border-amber-300 bg-amber-50 p-4"
            >
              <div className="flex items-start gap-3">
                <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" strokeWidth={2.25} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold tracking-tight text-amber-900">
                    {t("dl.authTitle")}
                  </h3>
                  <p className="mt-1 text-xs font-semibold leading-snug text-amber-800">
                    {authHint.cookiesOn ? t("dl.authOn") : t("dl.authOff")}
                  </p>
                  <p className="mt-1.5 break-all text-[11px] font-medium leading-snug text-amber-700/80">
                    {authHint.detail}
                  </p>
                </div>
              </div>
              <button
                onClick={onOpenSettings}
                className="flex items-center gap-2 rounded-ui border-2 border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-all hover:bg-amber-200 active:scale-95"
              >
                <SettingsIcon className="h-3.5 w-3.5" strokeWidth={2.25} />
                {t("dl.openSettings")}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Ручной поиск: сервис без прямой поддержки (Spotify/Apple/VK/Звук) */}
        <AnimatePresence>
          {manual && !info && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="mestia-anim w-full space-y-4 rounded-ui border-2 border-fog bg-paper/40 p-5"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-ui border-2 border-accent bg-accent/10 text-accent">
                  <Search className="h-5 w-5" strokeWidth={2.25} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold leading-tight tracking-tight">
                    {t("dl.serviceNotDirect", { service: SERVICE_LABELS[manual] ?? t("dl.thisService") })}
                  </h3>
                  <p className="mt-1 text-xs font-semibold leading-snug text-smoke">
                    {t("dl.manualHint")}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleManualSearch()}
                  autoFocus
                  placeholder={t("dl.manualPlaceholder")}
                  className="flex-1 rounded-ui border-2 border-accent bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none"
                />
                <button
                  onClick={handleManualSearch}
                  disabled={!manualQuery.trim() || phase === "fetching"}
                  className="flex shrink-0 items-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  {phase === "fetching" ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                  ) : (
                    <Search className="h-4 w-4" strokeWidth={2.25} />
                  )}
                  {t("dl.find")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
        {info && phase !== "fetching" && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="mestia-anim w-full space-y-5 rounded-ui border-2 border-fog bg-paper/40 p-5"
          >
            {/* Шапка: видео или плейлист */}
            {isPlaylist ? (
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-ui border-2 border-accent bg-accent/10 text-accent">
                  <ListVideo className="h-7 w-7" strokeWidth={2.25} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-[11px] font-bold uppercase tracking-wider text-accent">
                    {t("dl.playlist")}
                  </div>
                  <h3 className="line-clamp-2 font-semibold leading-tight tracking-tight">
                    {info.title}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-smoke">
                    {t("dl.videos", { count: info.playlist_count ?? "?" })} · {info.platform ?? "—"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex gap-4">
                <div className="flex aspect-video w-44 shrink-0 items-center justify-center overflow-hidden rounded-ui border-2 border-fog bg-fog">
                  {info.thumbnail ? (
                    <img src={info.thumbnail} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Video className="h-8 w-8 text-smoke" strokeWidth={2.25} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="line-clamp-2 font-semibold leading-tight tracking-tight">
                    {info.title}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-smoke">
                    {info.uploader ?? "—"} · {formatDuration(info.duration)} ·{" "}
                    {info.platform ?? "—"}
                  </p>
                </div>
              </div>
            )}

            {/* Ссылка на видео несёт и плейлист — предложить открыть его */}
            {alsoPlaylistId && (
              <button
                onClick={() => openAsPlaylist(alsoPlaylistId)}
                className="flex w-full items-center justify-center gap-2 rounded-ui border-2 border-dashed border-accent/60 px-3 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/10"
              >
                <ListVideo className="h-4 w-4" strokeWidth={2.25} />
                {t("dl.alsoPlaylist")}
              </button>
            )}

            {/* Режим плейлиста */}
            {isPlaylist && (
              <div className="space-y-2">
                {/* Имя папки — предзаполнено названием плейлиста, редактируется */}
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-smoke">
                    {t("dl.playlistFolder")}
                  </label>
                  <input
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    placeholder={info.title}
                    className="w-full rounded-ui border-2 border-fog bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none focus:border-accent"
                  />
                  <p className="text-[11px] font-semibold text-smoke">{t("dl.playlistFolderHint")}</p>
                </div>
                <div className="flex gap-2">
                  {(["all", "range"] as const).map((m) => {
                    const active = plMode === m;
                    return (
                      <button
                        key={m}
                        onClick={() => setPlMode(m)}
                        className={`relative flex-1 rounded-ui border-2 border-transparent px-3 py-2 text-sm font-semibold ${
                          active ? "" : "hover:bg-fog"
                        }`}
                      >
                        {active && (
                          <motion.span
                            layoutId="plPill"
                            transition={{ type: "spring", stiffness: 500, damping: 38 }}
                            className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-ink bg-snow"
                          />
                        )}
                        <span className="relative z-10">
                          {m === "all" ? t("dl.wholePlaylist", { count: info.playlist_count ?? "?" }) : t("dl.range")}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {plMode === "range" && (
                  <input
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    placeholder={t("dl.rangePlaceholder")}
                    className="w-full rounded-ui border-2 border-accent bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none"
                  />
                )}
              </div>
            )}

            {/* Тип медиа */}
            <div className="flex gap-2">
              {(["video", "audio"] as const).map((k) => {
                const active = mediaKind === k;
                const Icon = k === "video" ? Video : Music;
                return (
                  <button
                    key={k}
                    onClick={() => pickKind(k)}
                    className={`relative flex items-center gap-2 rounded-ui border-2 border-transparent px-4 py-2 text-sm font-semibold ${
                      active ? "" : "hover:bg-fog"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="kindPill"
                        transition={{ type: "spring", stiffness: 500, damping: 38 }}
                        className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-ink bg-snow"
                      />
                    )}
                    <Icon className="relative z-10 h-4 w-4" strokeWidth={2.25} />
                    <span className="relative z-10">{k === "video" ? t("dl.video") : t("dl.audio")}</span>
                  </button>
                );
              })}
            </div>

            {/* Качество/формат. По умолчанию — компактная строка «Авто» с текущим
                пресетом; полный список раскрывается по «Настроить», чтобы не шуметь. */}
            {!showFormats ? (
              <button
                onClick={() => setShowFormats(true)}
                className="flex w-full items-center justify-between rounded-ui border-2 border-fog px-3 py-2 text-xs font-semibold transition-colors hover:border-accent"
              >
                <span className="flex items-center gap-1.5 text-smoke">
                  {t("dl.quality")}
                  <span className="text-ink">{formatLabel(fmt)}</span>
                  {sizeLabel(fmt) && <span className="text-smoke">· {sizeLabel(fmt)}</span>}
                </span>
                <span className="flex items-center gap-1 text-accent">
                  {t("dl.customize")}
                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} />
                </span>
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {formats
                  .filter((f) => {
                    const max = info.sizes?.max_height ?? null;
                    return !f.minHeight || max == null || max >= f.minHeight;
                  })
                  .map((f) => {
                  const active = fmt.id === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setFmt(f)}
                      className={`relative rounded-ui border-2 border-transparent px-3 py-1.5 text-xs font-semibold ${
                        active ? "text-accent" : "hover:bg-fog"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="fmtPill"
                          transition={{ type: "spring", stiffness: 500, damping: 38 }}
                          className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-accent bg-snow"
                        />
                      )}
                      <span className="relative z-10 flex items-center gap-1.5">
                        {formatLabel(f)}
                        {sizeLabel(f) && (
                          <span
                            className={`text-[10px] font-bold ${active ? "text-accent/70" : "text-smoke"}`}
                          >
                            {sizeLabel(f)}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Кнопка скачивания (запускается в фон) */}
            <button
              onClick={handleDownload}
              className="flex w-full items-center justify-center gap-2 rounded-ui bg-accent px-5 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
            >
              <ArrowDownToLine className="h-4 w-4" strokeWidth={2.25} />
              {isPlaylist
                ? t("dl.downloadPlaylist")
                : mediaKind === "video"
                ? t("dl.downloadVideo")
                : t("dl.downloadAudio")}
              {!isPlaylist && sizeLabel(fmt) && (
                <span className="font-bold opacity-80">· {sizeLabel(fmt)}</span>
              )}
            </button>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Конфликт: видео уже в медиатеке */}
      <Modal open={!!dup} onClose={() => setDup(null)}>
        {dup && (
          <>
            <h3 className="text-base font-semibold tracking-tight">{t("dl.dupTitle")}</h3>
            <p className="text-sm font-semibold leading-snug text-smoke">
              {t("dl.dupText", { title: dup.title })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDup(null)}
                className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => {
                  const fn = dup.onConfirm;
                  setDup(null);
                  fn();
                }}
                className="flex items-center gap-2 rounded-ui border-2 border-ink bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <RotateCcw className="h-4 w-4" strokeWidth={2.25} />
                {t("dl.redownload")}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Предупреждение: большой плейлист */}
      <Modal open={!!bigWarn} onClose={() => setBigWarn(null)}>
        {bigWarn && (
          <>
            <h3 className="text-base font-semibold tracking-tight">{t("dl.bigTitle")}</h3>
            <p className="text-sm font-semibold leading-snug text-smoke">
              {t("dl.bigText", { count: bigWarn.count })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBigWarn(null)}
                className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => {
                  const fn = bigWarn.onConfirm;
                  setBigWarn(null);
                  fn();
                }}
                className="flex items-center gap-2 rounded-ui border-2 border-ink bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <ArrowDownToLine className="h-4 w-4" strokeWidth={2.25} />
                {t("dl.downloadAll")}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
