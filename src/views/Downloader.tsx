import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ListVideo,
  Loader2,
  Music,
  Video,
} from "lucide-react";
import { AUDIO_FORMATS, VIDEO_FORMATS, fetchMetadata, formatDuration } from "../lib/ipc";
import type { DownloadFormat, FetchResult } from "../types";
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

  function handleDownload() {
    if (!info) return;
    const isPlaylist = info.is_playlist;
    const mode: "single" | "all" | "range" = isPlaylist ? plMode : "single";
    const items = mode === "range" ? range.trim() : null;
    if (mode === "range" && !items) {
      notify("Укажите номера видео, напр. 1-5, 8", "error");
      return;
    }

    // Запуск в фоне — можно сразу искать следующее.
    void start({
      url: url.trim(),
      format: fmt.format,
      isAudio: fmt.isAudio,
      audioFormat: fmt.isAudio ? fmt.ext : null,
      mode,
      items,
      meta: {
        title: info.title,
        platform: info.platform,
        webpage_url: info.webpage_url,
        isPlaylist,
      },
    });
    notify(isPlaylist ? "Плейлист добавлен в загрузки" : "Добавлено в загрузки");
    reset();
  }

  const formats = mediaKind === "video" ? VIDEO_FORMATS : AUDIO_FORMATS;
  const isPlaylist = info?.is_playlist ?? false;

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
            className="mestia-go flex h-10 w-10 shrink-0 items-center justify-center rounded-ui bg-accent text-white transition-all hover:opacity-90 active:scale-90 disabled:opacity-50"
          >
            {phase === "fetching" ? (
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.5} />
            ) : (
              <ArrowRight className="h-5 w-5" strokeWidth={2.75} />
            )}
          </button>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="w-full rounded-ui border-2 border-rose-400 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
            {error}
          </div>
        )}

        {info && phase !== "fetching" && (
          <div className="w-full space-y-5 rounded-ui border-2 border-fog bg-paper/40 p-5">
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
                  <button
                    onClick={() => setPlMode("all")}
                    className={`flex-1 rounded-ui border-2 px-3 py-2 text-sm font-semibold transition-all ${
                      plMode === "all" ? "border-ink bg-snow" : "border-fog hover:bg-fog"
                    }`}
                  >
                    Весь плейлист ({info.playlist_count ?? "?"})
                  </button>
                  <button
                    onClick={() => setPlMode("range")}
                    className={`flex-1 rounded-ui border-2 px-3 py-2 text-sm font-semibold transition-all ${
                      plMode === "range" ? "border-ink bg-snow" : "border-fog hover:bg-fog"
                    }`}
                  >
                    Диапазон
                  </button>
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
                    className={`flex items-center gap-2 rounded-ui border-2 px-4 py-2 text-sm font-semibold transition-all ${
                      active ? "border-ink bg-snow" : "border-fog hover:bg-fog"
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={2.25} />
                    {k === "video" ? "Видео" : "Аудио"}
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
                    className={`rounded-ui border-2 px-3 py-1.5 text-xs font-semibold transition-all ${
                      active ? "border-accent bg-snow text-accent" : "border-fog hover:bg-fog"
                    }`}
                  >
                    {f.label}
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
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
