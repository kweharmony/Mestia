import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ExternalLink,
  FastForward,
  Maximize,
  Music,
  Pause,
  PictureInPicture2,
  Play,
  Rewind,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { VideoRow } from "../types";
import { existingPaths, formatDuration, isAudioPath, openPath } from "../lib/ipc";

// Linux (webkit2gtk) без Android — на нём чаще всего не хватает GStreamer-кодеков.
const IS_LINUX = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

const SKIP = 15; // секунд

// ── Запоминание позиции воспроизведения ───────────────────────────────────────
// Храним в localStorage по id видео (как и громкость) — общий стейт между
// главным окном и мини-плеером (один origin). Восстанавливаем при открытии.
const posKey = (id: number) => `mestia.pos.${id}`;

function savePosition(id: number, time: number, duration: number) {
  // Не запоминаем самое начало и (почти) досмотренный конец — иначе ролик
  // будет «возобновляться» там, где смотреть уже нечего.
  if (time < 5 || (duration && time > duration - 10)) {
    localStorage.removeItem(posKey(id));
  } else {
    localStorage.setItem(posKey(id), String(time));
  }
}

function loadPosition(id: number): number {
  const raw = localStorage.getItem(posKey(id));
  const v = raw === null ? NaN : parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function clearPosition(id: number) {
  localStorage.removeItem(posKey(id));
}

/** Открыть выбранное видео/аудио в отдельном плавающем окне. */
async function openMiniWindow(video: VideoRow) {
  const label = `mini-${video.id}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(label, {
    url: `index.html?mini=${video.id}`,
    title: video.title,
    width: 480,
    height: 300,
    minWidth: 280,
    minHeight: 170,
    resizable: true,
    alwaysOnTop: true,
    decorations: false, // безрамочное — управление наложено на видео
  });
}

export default function Player({
  video,
  queue,
  onChange,
  onClose,
  embedded = false,
}: {
  video: VideoRow;
  queue: VideoRow[];
  onChange: (v: VideoRow) => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const idx = queue.findIndex((v) => v.id === video.id);
  const prevVideo = idx > 0 ? queue[idx - 1] : null;
  const nextVideo = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
  const ref = useRef<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(localStorage.getItem("mestia.volume") ?? "1");
    return Number.isNaN(v) ? 1 : Math.min(1, Math.max(0, v));
  });
  const [muted, setMuted] = useState(false);
  // Причина сбоя воспроизведения: нет файла по пути / не удалось декодировать / иное.
  const [failKind, setFailKind] = useState<null | "missing" | "decode" | "unknown">(null);
  const failed = failKind !== null;

  const audio = isAudioPath(video.file_path);
  const src = convertFileSrc(video.file_path);
  const cover = video.thumbnail_path
    ? /^https?:/i.test(video.thumbnail_path)
      ? video.thumbnail_path
      : convertFileSrc(video.thumbnail_path)
    : null;

  function togglePlay() {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  }

  function skip(delta: number) {
    const el = ref.current;
    if (!el) return;
    const t = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
    el.currentTime = t;
    setTime(t);
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = ref.current;
    if (!el) return;
    const t = Number(e.target.value);
    el.currentTime = t;
    setTime(t);
  }

  function applyVolume(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    const el = ref.current;
    setVolume(clamped);
    setMuted(clamped === 0);
    localStorage.setItem("mestia.volume", String(clamped));
    if (el) {
      el.volume = clamped;
      el.muted = clamped === 0;
    }
  }

  function toggleMute() {
    const el = ref.current;
    if (!el) return;
    const next = !el.muted;
    el.muted = next;
    setMuted(next);
  }

  function toggleFullscreen() {
    if (audio) return; // для аудио полноэкранный режим не нужен
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }

  // Общие обработчики медиа-элемента.
  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => {
      ref.current = el;
    },
    src,
    autoPlay: true,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const t = e.currentTarget.currentTime;
      setTime(t);
      savePosition(video.id, t, e.currentTarget.duration);
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      setDuration(el.duration);
      el.volume = volume;
      // Возобновляем с последней сохранённой позиции (если она валидна).
      const saved = loadPosition(video.id);
      if (saved > 0 && (!el.duration || saved < el.duration - 1)) {
        el.currentTime = saved;
        setTime(saved);
      }
    },
    onEnded: () => {
      // Ролик досмотрен — сбрасываем позицию, чтобы в следующий раз начать сначала.
      clearPosition(video.id);
      // Автопереход к следующему треку очереди.
      if (nextVideo) onChange(nextVideo);
      else setPlaying(false);
    },
    onError: () => {
      // Различаем «файла нет по пути» (это и есть «проблема с путём») и сбой
      // декодирования (на Linux — обычно отсутствие кодеков gstreamer1.0-libav).
      existingPaths([video.file_path])
        .then(([ok]) => setFailKind(ok ? "decode" : "missing"))
        .catch(() => setFailKind("unknown"));
    },
  };

  // При смене видео сбрасываем прежнюю ошибку.
  useEffect(() => {
    setFailKind(null);
  }, [video.id]);

  // Горячие клавиши: Esc, пробел, ←/→ (±15с), ↑/↓ (громкость), F (полный экран).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          skip(-SKIP);
          break;
        case "ArrowRight":
          skip(SKIP);
          break;
        case "ArrowUp":
          e.preventDefault();
          applyVolume(volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          applyVolume(volume - 0.1);
          break;
        case "f":
        case "F":
        case "а":
        case "А":
          toggleFullscreen();
          break;
        case "n":
        case "N":
          if (nextVideo) onChange(nextVideo);
          break;
        case "p":
        case "P":
          if (prevVideo) onChange(prevVideo);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, volume]);

  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ── Сообщение о сбое воспроизведения (по причине failKind) ──────────────────
  function ErrorView({ compact }: { compact: boolean }) {
    const title =
      failKind === "missing"
        ? "Файл не найден"
        : "Не удалось воспроизвести файл";
    const hint =
      failKind === "missing"
        ? "Возможно, файл перемещён, удалён или хранится в другом расположении."
        : IS_LINUX
        ? "Похоже, в системе нет кодеков для этого формата. Установите их командой:"
        : "Формат файла не поддерживается проигрывателем.";
    return (
      <div
        className={`flex w-full flex-col items-center justify-center gap-2 bg-black px-6 text-center ${
          compact ? "h-full" : "min-h-[280px]"
        }`}
      >
        <span className={`font-semibold text-white/90 ${compact ? "text-sm" : "text-base"}`}>
          {title}
        </span>
        <span className={`text-white/60 ${compact ? "text-xs" : "text-sm"}`}>{hint}</span>
        {/* Запасной вариант: открыть в системном плеере (со своими кодеками). */}
        {failKind !== "missing" && (
          <button
            onClick={() => openPath(video.file_path).catch(() => {})}
            className="mt-2 flex items-center gap-2 rounded-ui bg-white/15 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/25"
          >
            <ExternalLink className="h-4 w-4" strokeWidth={2.25} />
            Открыть во внешнем плеере
          </button>
        )}
        {failKind === "decode" && IS_LINUX && (
          <code className="mt-1 select-all break-all rounded bg-white/10 px-2 py-1 text-[11px] text-white/70">
            …или установите кодеки: sudo apt install gstreamer1.0-libav
            gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
          </code>
        )}
        {!compact && (
          <span className="mt-1 break-all text-xs text-white/40">{video.file_path}</span>
        )}
      </div>
    );
  }

  // Компактные размеры контролов в отдельном окне — чтобы видео было больше.
  const ic = embedded ? "h-4 w-4" : "h-5 w-5";
  const btn = `shrink-0 rounded-ui ${embedded ? "p-1" : "p-2"} text-smoke hover:bg-fog hover:text-ink`;
  const headCls = `flex items-center justify-between border-b-2 border-fog ${
    embedded ? "px-2 py-1" : "px-4 py-3"
  }`;
  const rowCls = `flex items-center ${embedded ? "gap-1 px-2 py-1.5" : "gap-2 px-4 py-3"}`;

  // ── Отдельное окно: безрамочный оверлей — видео на всё окно, иконки поверх ──
  if (embedded) {
    const ov = "shrink-0 rounded-md p-1.5 text-white/90 transition-colors hover:bg-white/20 disabled:opacity-30";
    return (
      <div className="group relative h-screen w-screen overflow-hidden bg-black text-white">
        {/* Медиа на весь экран */}
        {failed ? (
          <ErrorView compact />
        ) : audio ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/30 to-black">
            {cover ? (
              <img src={cover} alt="" className="max-h-[70%] rounded-ui object-contain shadow-lg" />
            ) : (
              <Music className={`h-20 w-20 text-white/90 ${playing ? "mestia-pulse" : ""}`} strokeWidth={1.6} />
            )}
            <audio {...mediaProps} className="hidden" />
          </div>
        ) : (
          <video {...mediaProps} className="h-full w-full bg-black object-contain" onClick={togglePlay} />
        )}

        {/* Верх: зона перетаскивания окна + закрыть */}
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 flex h-10 items-center justify-end bg-gradient-to-b from-black/55 to-transparent px-2 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <button onClick={onClose} title="Закрыть" className={ov}>
            <X className="h-5 w-5" strokeWidth={2.25} />
          </button>
        </div>

        {/* Низ: иконки управления поверх видео */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/65 to-transparent px-2 pb-2 pt-7 opacity-0 transition-opacity group-hover:opacity-100">
          {queue.length > 1 && (
            <button onClick={() => prevVideo && onChange(prevVideo)} disabled={!prevVideo} title="Предыдущий (P)" className={ov}>
              <SkipBack className="h-4 w-4 fill-current" strokeWidth={2.25} />
            </button>
          )}
          <button onClick={() => skip(-SKIP)} title="Назад 15с (←)" className={ov}>
            <Rewind className="h-4 w-4" strokeWidth={2.25} />
          </button>
          <button onClick={togglePlay} className={ov}>
            {playing ? (
              <Pause className="h-5 w-5 fill-current" strokeWidth={2.25} />
            ) : (
              <Play className="h-5 w-5 fill-current" strokeWidth={2.25} />
            )}
          </button>
          <button onClick={() => skip(SKIP)} title="Вперёд 15с (→)" className={ov}>
            <FastForward className="h-4 w-4" strokeWidth={2.25} />
          </button>
          {queue.length > 1 && (
            <button onClick={() => nextVideo && onChange(nextVideo)} disabled={!nextVideo} title="Следующий (N)" className={ov}>
              <SkipForward className="h-4 w-4 fill-current" strokeWidth={2.25} />
            </button>
          )}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={seek}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, var(--c-accent) ${
                duration ? (time / duration) * 100 : 0
              }%, rgba(255,255,255,0.3) 0%)`,
            }}
          />
          <button onClick={toggleMute} title="Звук (M)" className={ov}>
            <VolIcon className="h-4 w-4" strokeWidth={2.25} />
          </button>
          {!audio && (
            <button onClick={toggleFullscreen} title="Полный экран (F)" className={ov}>
              <Maximize className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
        </div>

        {/* Уголок изменения размера */}
        <div
          onMouseDown={() =>
            getCurrentWindow()
              .startResizeDragging("SouthEast" as never)
              .catch(() => {})
          }
          className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-se-resize"
        />
      </div>
    );
  }

  return (
    <div
      className={
        embedded
          ? "flex h-screen w-screen flex-col bg-snow text-ink"
          : "fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm"
      }
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={
          embedded
            ? "flex h-full w-full flex-col overflow-hidden bg-snow"
            : "flex w-full max-w-[900px] flex-col overflow-hidden rounded-ui border-2 border-ink bg-snow"
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Заголовок */}
        <div className={headCls}>
          <h3 className="flex min-w-0 items-center gap-2 truncate pr-4 text-sm font-semibold tracking-tight">
            {audio && <Music className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.5} />}
            <span className="truncate">{video.title}</span>
          </h3>
          <button
            onClick={onClose}
            className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
          >
            <X className="h-5 w-5" strokeWidth={2.25} />
          </button>
        </div>

        {/* Медиа */}
        {failed ? (
          <ErrorView compact={false} />
        ) : audio ? (
          <div
            className={`relative flex w-full flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-br from-accent/20 to-accent/5 px-6 ${
              embedded ? "min-h-0 flex-1" : "min-h-[280px]"
            }`}
          >
            {video.thumbnail_path ? (
              <div
                className={`h-40 w-40 overflow-hidden rounded-ui border-2 border-fog shadow-lg ${
                  playing ? "mestia-pulse" : ""
                }`}
              >
                <img
                  src={
                    /^https?:/i.test(video.thumbnail_path)
                      ? video.thumbnail_path
                      : convertFileSrc(video.thumbnail_path)
                  }
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div
                className={`flex h-28 w-28 items-center justify-center rounded-full bg-accent text-white shadow-lg ${
                  playing ? "mestia-pulse" : ""
                }`}
              >
                <Music className="h-12 w-12" strokeWidth={2} />
              </div>
            )}
            <div className="line-clamp-2 max-w-[80%] text-center text-sm font-semibold">
              {video.title}
            </div>
            <audio {...mediaProps} className="hidden" />
          </div>
        ) : (
          <video
            {...mediaProps}
            className={
              embedded
                ? "min-h-0 w-full flex-1 bg-black object-contain"
                : "max-h-[60vh] min-h-[280px] w-full bg-black"
            }
            onClick={togglePlay}
          />
        )}

        {/* Контролы */}
        <div className={rowCls}>
          {queue.length > 1 && (
            <button
              onClick={() => prevVideo && onChange(prevVideo)}
              disabled={!prevVideo}
              title="Предыдущий (P)"
              className={`${btn} disabled:opacity-30`}
            >
              <SkipBack className={`${ic} fill-current`} strokeWidth={2.25} />
            </button>
          )}

          <button onClick={() => skip(-SKIP)} title="Назад 15 секунд (←)" className={btn}>
            <Rewind className={ic} strokeWidth={2.25} />
          </button>

          <button
            onClick={togglePlay}
            className={`flex shrink-0 items-center justify-center rounded-ui bg-accent text-white transition-all hover:opacity-90 active:scale-95 ${
              embedded ? "h-8 w-8" : "h-10 w-10"
            }`}
          >
            {playing ? (
              <Pause className={`${ic} fill-current`} strokeWidth={2.25} />
            ) : (
              <Play className={`${ic} fill-current`} strokeWidth={2.25} />
            )}
          </button>

          <button onClick={() => skip(SKIP)} title="Вперёд 15 секунд (→)" className={btn}>
            <FastForward className={ic} strokeWidth={2.25} />
          </button>

          {queue.length > 1 && (
            <button
              onClick={() => nextVideo && onChange(nextVideo)}
              disabled={!nextVideo}
              title="Следующий (N)"
              className={`${btn} disabled:opacity-30`}
            >
              <SkipForward className={`${ic} fill-current`} strokeWidth={2.25} />
            </button>
          )}

          <span className="shrink-0 text-xs font-semibold tabular-nums text-smoke">
            {formatDuration(time)}
          </span>

          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={seek}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, var(--c-accent) ${
                duration ? (time / duration) * 100 : 0
              }%, var(--c-fog) 0%)`,
            }}
          />

          {!embedded && (
            <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-smoke">
              {formatDuration(duration)}
            </span>
          )}

          {/* Громкость (в мини-окне — только кнопка mute) */}
          <button onClick={toggleMute} title="Звук (M)" className={btn}>
            <VolIcon className={ic} strokeWidth={2.25} />
          </button>
          {!embedded && (
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => applyVolume(Number(e.target.value))}
              title="Громкость (↑/↓)"
              className="h-1.5 w-20 shrink-0 cursor-pointer appearance-none rounded-full"
              style={{
                background: `linear-gradient(to right, var(--c-accent) ${
                  (muted ? 0 : volume) * 100
                }%, var(--c-fog) 0%)`,
              }}
            />
          )}

          {!embedded && (
            <button
              onClick={() => openPath(video.file_path).catch(() => {})}
              title="Открыть во внешнем плеере"
              className={btn}
            >
              <ExternalLink className={ic} strokeWidth={2.25} />
            </button>
          )}

          {!embedded && (
            <button
              onClick={() => {
                openMiniWindow(video);
                onClose();
              }}
              title="В отдельном окне"
              className={btn}
            >
              <PictureInPicture2 className={ic} strokeWidth={2.25} />
            </button>
          )}

          {!audio && (
            <button onClick={toggleFullscreen} title="Полный экран (F)" className={btn}>
              <Maximize className={ic} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
