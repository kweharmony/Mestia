import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowRight,
  ListVideo,
  Loader2,
  Music,
  RotateCcw,
  Video,
} from "lucide-react";
import {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  estimateAudioBytes,
  existingPaths,
  fetchMetadata,
  formatBytes,
  formatDuration,
} from "../lib/ipc";
import { findVideoByUrl } from "../lib/db";
import type { DownloadFormat, FetchResult, FormatSizes } from "../types";
import { useToast } from "../components/Toast";
import { useDownloads } from "../context/DownloadsContext";
import Typewriter from "../components/Typewriter";

type Phase = "idle" | "fetching" | "ready";
type PlMode = "all" | "range";

const PLACEHOLDERS = [
  "Кидай ссылку — дальше моя забота…",
  "YouTube, Rutube, VK… неси любую ссылку…",
  "Плейлист на 100 видео? Да без проблем…",
  "Видео или аудио — как пожелаешь…",
  "Вставь ссылку и налей себе чаю ☕",
  "Спасём ролик, пока его не удалили…",
];

export default function Downloader() {
  const { notify } = useToast();
  const { start } = useDownloads();

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<FetchResult | null>(null);
  const [mediaKind, setMediaKind] = useState<"video" | "audio">("video");
  const [fmt, setFmt] = useState<DownloadFormat>(VIDEO_FORMATS[0]);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [plMode, setPlMode] = useState<PlMode>("all");
  const [range, setRange] = useState("");
  // Видео уже в медиатеке — модалка подтверждения повторной загрузки.
  const [dup, setDup] = useState<{ title: string; onConfirm: () => void } | null>(null);

  function reset() {
    setInfo(null);
    setUrl("");
    setError(null);
    setPhase("idle");
    setRange("");
    setPlMode("all");
  }

  function handleUrlChange(v: string) {
    setUrl(v);
    if (info || phase !== "idle") {
      setInfo(null);
      setError(null);
      setPhase("idle");
    }
  }

  async function handleFetch() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setInfo(null);
    setPhase("fetching");
    try {
      const r = await fetchMetadata(trimmed);
      setInfo(r);
      setPlMode("all");
      setRange("");
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      notify("Не удалось получить данные по ссылке", "error");
    }
  }

  function pickKind(kind: "video" | "audio") {
    setMediaKind(kind);
    setFmt(kind === "video" ? VIDEO_FORMATS[0] : AUDIO_FORMATS[0]);
  }

  async function handleDownload() {
    if (!info) return;
    const isPlaylist = info.is_playlist;
    const mode: "single" | "all" | "range" = isPlaylist ? plMode : "single";
    const items = mode === "range" ? range.trim() : null;
    if (mode === "range" && !items) {
      notify("Укажите номера видео, напр. 1-5, 8", "error");
      return;
    }

    // Запуск в фоне — можно сразу искать следующее. recovery="restart"
    // перезаписывает существующий файл (для повторного скачивания).
    const launch = (recovery?: "restart") => {
      void start({
        url: url.trim(),
        format: fmt.format,
        isAudio: fmt.isAudio,
        audioFormat: fmt.isAudio ? fmt.ext : null,
        mode,
        items,
        recovery,
        meta: {
          title: info.title,
          platform: info.platform,
          webpage_url: info.webpage_url,
          isPlaylist,
        },
      });
      notify(isPlaylist ? "Плейлист добавлен в загрузки" : "Добавлено в загрузки");
      reset();
    };

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
        <h1 className="text-2xl font-normal tracking-tight">Что будем скачивать?</h1>

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
              <Typewriter phrases={PLACEHOLDERS} className="whitespace-nowrap" />
            </div>
          )}
          <button
            onClick={handleFetch}
            disabled={phase === "fetching"}
            aria-label="Проверить"
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
                    Плейлист
                  </div>
                  <h3 className="line-clamp-2 font-semibold leading-tight tracking-tight">
                    {info.title}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-smoke">
                    {info.playlist_count ?? "?"} видео · {info.platform ?? "—"}
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

            {/* Режим плейлиста */}
            {isPlaylist && (
              <div className="space-y-2">
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
                          {m === "all" ? `Весь плейлист (${info.playlist_count ?? "?"})` : "Диапазон"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {plMode === "range" && (
                  <input
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    placeholder="Например: 1-5, 8, 10-12"
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
                    <span className="relative z-10">{k === "video" ? "Видео" : "Аудио"}</span>
                  </button>
                );
              })}
            </div>

            {/* Качество/формат */}
            <div className="flex flex-wrap gap-2">
              {formats.map((f) => {
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
                      {f.label}
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

            {/* Кнопка скачивания (запускается в фон) */}
            <button
              onClick={handleDownload}
              className="flex w-full items-center justify-center gap-2 rounded-ui bg-accent px-5 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
            >
              <ArrowDownToLine className="h-4 w-4" strokeWidth={2.25} />
              {isPlaylist
                ? "Скачать плейлист"
                : `Скачать ${mediaKind === "video" ? "видео" : "аудио"}`}
              {!isPlaylist && sizeLabel(fmt) && (
                <span className="font-bold opacity-80">· {sizeLabel(fmt)}</span>
              )}
            </button>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Конфликт: видео уже в медиатеке */}
      <AnimatePresence>
        {dup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mestia-anim fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
            onClick={() => setDup(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="mestia-anim w-full max-w-[400px] space-y-5 rounded-ui border-2 border-ink bg-snow p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold tracking-tight">Уже в медиатеке</h3>
              <p className="text-sm font-semibold leading-snug text-smoke">
                «{dup.title}» уже скачано. Скачать заново? Существующий файл будет
                перезаписан.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDup(null)}
                  className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
                >
                  Отмена
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
                  Скачать заново
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
