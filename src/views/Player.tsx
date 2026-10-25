import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ExternalLink,
  FastForward,
  Maximize,
  Minimize,
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
import { existingPaths, formatDuration, getSetting, isAudioPath, openPath, setFullscreen, subtitleTrack } from "../lib/ipc";
import { useI18n } from "../context/LanguageContext";
import { IS_ANDROID } from "../lib/platform";
import { onMediaAction, setNowPlaying, useMediaSrc } from "../lib/media";

// Linux (webkit2gtk) без Android — на нём чаще всего не хватает GStreamer-кодеков.
const IS_LINUX = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

const DEFAULT_SKIP = 15; // секунд (настраивается в параметрах)

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
  const { t } = useI18n();
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
  const [skipSec, setSkipSec] = useState(DEFAULT_SKIP);
  const [subs, setSubs] = useState<string | null>(null); // src дорожки субтитров (.vtt)
  // Причина сбоя воспроизведения: нет файла по пути / не удалось декодировать / иное.
  const [failKind, setFailKind] = useState<null | "missing" | "decode" | "unknown">(null);
  const failed = failKind !== null;
  // Android: «свой» полноэкранный режим (HTML-fullscreen в WebView Tauri не работает) —
  // плеер растягивается на весь экран, а нативная часть прячет панели и поворачивает экран.
  const [immersive, setImmersive] = useState<null | { landscape: boolean }>(null);

  const audio = isAudioPath(video.file_path);
  const src = useMediaSrc(video.file_path);
  const cover = video.thumbnail_path
    ? /^https?:/i.test(video.thumbnail_path)
      ? video.thumbnail_path
      : convertFileSrc(video.thumbnail_path)
    : null;

  // Шаг перемотки берём из настроек (по умолчанию 15с).
  useEffect(() => {
    getSetting("skipSeconds")
      .then((v) => {
        const n = parseInt(v ?? "", 10);
        if (Number.isFinite(n) && n > 0) setSkipSec(Math.min(120, Math.max(5, n)));
      })
      .catch(() => {});
  }, []);

  // Внешние субтитры (.srt/.vtt рядом с файлом) — конвертируются в data:URL .vtt.
  useEffect(() => {
    setSubs(null);
    if (audio) return;
    subtitleTrack(video.file_path)
      .then((vtt) => vtt && setSubs(`data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`))
      .catch(() => {});
  }, [video.file_path, audio]);

  function togglePlay() {
    const el = ref.current;
    if (!el) return;
    // Состояние playing обновляют события onPlay/onPause элемента.
    if (el.paused) el.play().catch(() => {});
    else pauseByUser();
  }

  // Пауза от пользователя (кнопка, клавиша, медиапанель) — в отличие от системной,
  // которую WebView ставит, когда гаснет экран (её отменяем в onPause).
  const userPause = useRef(false);
  const autoResumes = useRef(0);
  function pauseByUser() {
    userPause.current = true;
    ref.current?.pause();
  }

  // Системная медиапанель: Android — уведомление с обложкой и ⏮ ⏯ ⏭,
  // компьютер — медиа-оверлей ОС (navigator.mediaSession).
  function pushNowPlaying() {
    const el = ref.current;
    if (!el) return;
    setNowPlaying({
      title: video.title,
      artist: video.platform,
      artwork: video.thumbnail_path,
      path: video.file_path,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      position: el.currentTime,
      playing: !el.paused,
      rate: el.playbackRate,
      hasPrev: !!prevVideo,
      hasNext: !!nextVideo,
    });
  }
  const actionRef = useRef<(a: { action: string; position?: number }) => void>(() => {});
  actionRef.current = (a) => {
    const el = ref.current;
    if (!el) return;
    switch (a.action) {
      case "play":
        el.play().catch(() => {});
        break;
      case "pause":
        pauseByUser();
        break;
      case "next":
        if (nextVideo) onChange(nextVideo);
        break;
      case "prev":
        if (prevVideo) onChange(prevVideo);
        else el.currentTime = 0;
        break;
      case "seek":
        if (a.position != null) el.currentTime = a.position;
        break;
    }
  };
  useEffect(() => onMediaAction((a) => actionRef.current(a)), []);
  // Сменились соседи в очереди — обновить доступность ⏮/⏭.
  useEffect(() => {
    pushNowPlaying();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevVideo?.id, nextVideo?.id]);
  // Экран снова включён — разрешаем новые попытки автовозобновления.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) autoResumes.current = 0;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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
    if (IS_ANDROID) {
      // Ориентация — по самому ролику: вертикальные (Shorts) остаются портретными.
      const v = el as HTMLVideoElement;
      setImmersive((cur) => (cur ? null : { landscape: v.videoWidth >= v.videoHeight }));
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }

  // Нативная часть полноэкранного режима; выход — и при закрытии плеера/смене ролика.
  useEffect(() => {
    if (!immersive) return;
    setFullscreen(true, immersive.landscape).catch(() => {});
    return () => {
      setFullscreen(false, true).catch(() => {});
    };
  }, [immersive]);

  // Android: повернули телефон горизонтально с открытым видео — сразу на весь экран
  // (как в YouTube). Выход — кнопкой или «Назад».
  useEffect(() => {
    if (!IS_ANDROID || audio) return;
    const mq = window.matchMedia("(orientation: landscape)");
    const onChange = () => {
      if (mq.matches) setImmersive((cur) => cur ?? { landscape: true });
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [audio]);

  // Видео: контролы поверх кадра прячутся через 5 с без касаний/движения мыши (на паузе — видны).
  // poke — «пользователь что-то трогал»: показать и перезапустить отсчёт.
  const [controlsShown, setControlsShown] = useState(true);
  const [pokeTick, setPokeTick] = useState(0);
  const poke = () => {
    setControlsShown(true);
    setPokeTick((n) => n + 1);
  };
  useEffect(() => {
    if (!playing) {
      setControlsShown(true);
      return;
    }
    const t = window.setTimeout(() => setControlsShown(false), 5000);
    return () => window.clearTimeout(t);
  }, [playing, pokeTick]);

  // Системная «Назад» (см. App): сперва выходим из полноэкранного режима.
  useEffect(() => {
    if (!immersive) return;
    const onBack = (e: Event) => {
      e.preventDefault();
      setImmersive(null);
    };
    window.addEventListener("mestia:back", onBack);
    return () => window.removeEventListener("mestia:back", onBack);
  }, [immersive]);

  // Общие обработчики медиа-элемента.
  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => {
      ref.current = el;
    },
    src,
    autoPlay: true,
    // Истина — у самого элемента: autoplay может не сработать, а пауза прийти из
    // системных медиа-клавиш или нативного полноэкранного режима.
    onPlay: () => {
      setPlaying(true);
      pushNowPlaying();
    },
    onPause: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      // Android: с погасшим экраном WebView ставит видео на паузу сам — продолжаем.
      // Пару попыток, чтобы не спорить с системой бесконечно.
      if (IS_ANDROID && document.hidden && !userPause.current && !el.ended && autoResumes.current < 2) {
        autoResumes.current += 1;
        el.play().catch(() => {});
        return;
      }
      userPause.current = false;
      setPlaying(false);
      pushNowPlaying();
    },
    onSeeked: () => pushNowPlaying(),
    onRateChange: () => pushNowPlaying(),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const t = e.currentTarget.currentTime;
      setTime(t);
      savePosition(video.id, t, e.currentTarget.duration);
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      setDuration(el.duration);
      pushNowPlaying();
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
    },
    onError: () => {
      // Различаем «файла нет по пути» (это и есть «проблема с путём») и сбой
      // декодирования (на Linux — обычно отсутствие кодеков gstreamer1.0-libav).
      existingPaths([video.file_path])
        .then(([ok]) => setFailKind(ok ? "decode" : "missing"))
        .catch(() => setFailKind("unknown"));
    },
  };

  // Закрыли плеер — убрать медиапанель (и телефону снова можно засыпать).
  useEffect(() => () => setNowPlaying(null), []);

  // При смене видео сбрасываем прежнюю ошибку.
  useEffect(() => {
    setFailKind(null);
  }, [video.id]);

  // Горячие клавиши: Esc, пробел, ←/→ (±шаг), ↑/↓ (громкость), F (полный экран),
  // M (звук), N/P (след./пред.); дублируем русскую раскладку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          if (immersive) setImmersive(null);
          else onClose();
          break;
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          skip(-skipSec);
          break;
        case "ArrowRight":
          skip(skipSec);
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
        case "m":
        case "M":
        case "ь":
        case "Ь":
          toggleMute();
          break;
        case "n":
        case "N":
        case "т":
        case "Т":
          if (nextVideo) onChange(nextVideo);
          break;
        case "p":
        case "P":
        case "з":
        case "З":
          if (prevVideo) onChange(prevVideo);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, volume, skipSec, immersive]);

  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ── Сообщение о сбое воспроизведения (по причине failKind) ──────────────────
  function ErrorView({ compact }: { compact: boolean }) {
    const title =
      failKind === "missing" ? t("player.fileNotFound") : t("player.playFailed");
    const hint =
      failKind === "missing"
        ? t("player.missingHint")
        : IS_LINUX
        ? t("player.linuxCodec")
        : t("player.formatUnsupported");
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
            {t("player.external")}
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

  // Дорожка субтитров для <video>.
  const subTrack = subs ? (
    <track kind="subtitles" src={subs} srcLang="und" label={t("player.subtitles")} default />
  ) : null;

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
          <video {...mediaProps} className="h-full w-full bg-black object-contain" onClick={togglePlay}>
            {subTrack}
          </video>
        )}

        {/* Верх: зона перетаскивания окна + закрыть */}
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 flex h-10 items-center justify-end bg-gradient-to-b from-black/55 to-transparent px-2 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <button onClick={onClose} title={t("player.close")} className={ov}>
            <X className="h-5 w-5" strokeWidth={2.25} />
          </button>
        </div>

        {/* Низ: иконки управления поверх видео */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/65 to-transparent px-2 pb-2 pt-7 opacity-0 transition-opacity group-hover:opacity-100">
          {queue.length > 1 && (
            <button onClick={() => prevVideo && onChange(prevVideo)} disabled={!prevVideo} title={`${t("player.prev")} (P)`} className={ov}>
              <SkipBack className="h-4 w-4 fill-current" strokeWidth={2.25} />
            </button>
          )}
          <button onClick={() => skip(-skipSec)} title={`${t("player.back", { n: skipSec })} (←)`} className={ov}>
            <Rewind className="h-4 w-4" strokeWidth={2.25} />
          </button>
          <button onClick={togglePlay} className={ov}>
            {playing ? (
              <Pause className="h-5 w-5 fill-current" strokeWidth={2.25} />
            ) : (
              <Play className="h-5 w-5 fill-current" strokeWidth={2.25} />
            )}
          </button>
          <button onClick={() => skip(skipSec)} title={`${t("player.forward", { n: skipSec })} (→)`} className={ov}>
            <FastForward className="h-4 w-4" strokeWidth={2.25} />
          </button>
          {queue.length > 1 && (
            <button onClick={() => nextVideo && onChange(nextVideo)} disabled={!nextVideo} title={`${t("player.next")} (N)`} className={ov}>
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
          <button onClick={toggleMute} title={`${t("player.sound")} (M)`} className={ov}>
            <VolIcon className="h-4 w-4" strokeWidth={2.25} />
          </button>
          {!audio && (
            <button onClick={toggleFullscreen} title={`${t("player.fullscreen")} (F)`} className={ov}>
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

  // ── Аудиоплеер: карточка музыкального плеера, обложка — главный элемент ─────
  if (audio) {
    const abtn = "shrink-0 rounded-full p-2 text-smoke transition-colors hover:bg-fog hover:text-ink disabled:opacity-30";
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm md:p-8"
        onClick={onClose}
      >
        <div
          className="flex w-full max-w-[400px] flex-col overflow-hidden rounded-ui border-2 border-ink bg-snow shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Обложка — квадрат во всю ширину, с мягким свечением из неё же */}
          <div className="relative aspect-square w-full overflow-hidden bg-gradient-to-br from-accent/20 to-accent/5">
            {/* Кнопка закрытия поверх обложки */}
            <button
              onClick={onClose}
              aria-label={t("player.close")}
              className="absolute right-2.5 top-2.5 z-20 rounded-ui bg-black/35 p-1.5 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/55"
            >
              <X className="h-4 w-4" strokeWidth={2.25} />
            </button>

            {failed ? (
              <ErrorView compact />
            ) : (
              <>
                {cover && (
                  <img
                    src={cover}
                    alt=""
                    aria-hidden
                    className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-45 blur-3xl"
                  />
                )}
                <div className="relative flex h-full w-full items-center justify-center p-2.5">
                  {cover ? (
                    <img
                      src={cover}
                      alt=""
                      className="max-h-full max-w-full rounded-ui border-2 border-ink/10 object-contain shadow-lg"
                    />
                  ) : (
                    <div
                      className={`flex h-36 w-36 items-center justify-center rounded-full bg-accent text-white shadow-lg ${
                        playing ? "mestia-pulse" : ""
                      }`}
                    >
                      <Music className="h-16 w-16" strokeWidth={2} />
                    </div>
                  )}
                </div>
                <audio {...mediaProps} className="hidden" />
              </>
            )}
          </div>

          {/* Инфо + управление — как карточка музыкального плеера: подпись источника,
              название, тонкая полоса со временем, крупный транспорт по центру. */}
          <div className="flex flex-col gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0 text-center">
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-smoke">
                {video.platform ?? t("dl.audio")}
              </p>
              <h3 className="mt-1 truncate text-base font-semibold tracking-tight">{video.title}</h3>
            </div>

            {/* Полоса перемотки */}
            <div>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={time}
                onChange={seek}
                aria-label={t("player.seek")}
                className="h-1 w-full cursor-pointer appearance-none rounded-full"
                style={{
                  background: `linear-gradient(to right, var(--c-accent) ${
                    duration ? (time / duration) * 100 : 0
                  }%, var(--c-fog) 0%)`,
                }}
              />
              <div className="mt-1 flex justify-between text-[10px] font-semibold tabular-nums text-smoke">
                <span>{formatDuration(time)}</span>
                <span>{formatDuration(duration)}</span>
              </div>
            </div>

            {/* Транспорт */}
            <div className="flex items-center justify-center gap-1">
              {queue.length > 1 && (
                <button
                  onClick={() => prevVideo && onChange(prevVideo)}
                  disabled={!prevVideo}
                  title={`${t("player.prev")} (P)`}
                  aria-label={t("player.prev")}
                  className={abtn}
                >
                  <SkipBack className="h-5 w-5 fill-current" strokeWidth={2.25} />
                </button>
              )}
              <button onClick={() => skip(-skipSec)} title={`${t("player.back", { n: skipSec })} (←)`} aria-label={t("player.backAria")} className={abtn}>
                <Rewind className="h-5 w-5" strokeWidth={2.25} />
              </button>
              <button
                onClick={togglePlay}
                aria-label={playing ? t("player.pause") : t("player.play")}
                className="mx-2 flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md transition-all hover:opacity-90 active:scale-95"
              >
                {playing ? (
                  <Pause className="h-6 w-6 fill-current" strokeWidth={2.25} />
                ) : (
                  <Play className="h-6 w-6 translate-x-[2px] fill-current" strokeWidth={2.25} />
                )}
              </button>
              <button onClick={() => skip(skipSec)} title={`${t("player.forward", { n: skipSec })} (→)`} aria-label={t("player.forwardAria")} className={abtn}>
                <FastForward className="h-5 w-5" strokeWidth={2.25} />
              </button>
              {queue.length > 1 && (
                <button
                  onClick={() => nextVideo && onChange(nextVideo)}
                  disabled={!nextVideo}
                  title={`${t("player.next")} (N)`}
                  aria-label={t("player.next")}
                  className={abtn}
                >
                  <SkipForward className="h-5 w-5 fill-current" strokeWidth={2.25} />
                </button>
              )}
            </div>

            {/* Второстепенное: громкость и действия */}
            <div className="flex items-center justify-between gap-2 border-t-2 border-fog pt-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <button onClick={toggleMute} title={`${t("player.sound")} (M)`} aria-label={t("player.sound")} className={abtn}>
                  <VolIcon className="h-4 w-4" strokeWidth={2.25} />
                </button>
                {/* На телефоне громкость — кнопками устройства. */}
                {!IS_ANDROID && (
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    onChange={(e) => applyVolume(Number(e.target.value))}
                    title={`${t("player.volume")} (↑/↓)`}
                    aria-label={t("player.volume")}
                    className="h-1 w-20 cursor-pointer appearance-none rounded-full"
                    style={{
                      background: `linear-gradient(to right, var(--c-accent) ${
                        (muted ? 0 : volume) * 100
                      }%, var(--c-fog) 0%)`,
                    }}
                  />
                )}
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => openPath(video.file_path).catch(() => {})}
                  title={t("player.external")}
                  aria-label={t("player.externalAria")}
                  className={abtn}
                >
                  <ExternalLink className="h-4 w-4" strokeWidth={2.25} />
                </button>
                {/* Отдельных окон на Android нет. */}
                {!IS_ANDROID && (
                  <button
                    onClick={() => {
                      openMiniWindow(video);
                      onClose();
                    }}
                    title={t("player.miniWindow")}
                    aria-label={t("player.miniWindow")}
                    className={abtn}
                  >
                    <PictureInPicture2 className="h-4 w-4" strokeWidth={2.25} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Видеоплеер в главном окне (мини-окно и аудио обработаны выше) ──────────
  // Раскладка как у limeplay: управление поверх кадра. Сверху — название, снизу —
  // один ряд: крупная круглая «играть», время с перемоткой, остальные кнопки.
  // Пока играет, слой управления прячется через 5 с без движения (на паузе — виден).
  const ic = "h-5 w-5";
  const btn = "shrink-0 rounded-full p-2 text-white/90 transition-colors hover:bg-white/15 active:bg-white/25 disabled:opacity-30";
  const layer = `transition-opacity duration-300 ${controlsShown ? "opacity-100" : "pointer-events-none opacity-0"}`;
  return (
    <div
      className={
        immersive
          ? "fixed inset-0 z-50 flex bg-black"
          : "fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm md:p-8"
      }
      onClick={immersive ? undefined : onClose}
    >
      <div
        className={
          immersive
            ? "relative flex h-full w-full bg-black"
            : "relative flex max-h-full w-full max-w-[1100px] overflow-hidden rounded-ui border-2 border-ink bg-black shadow-2xl md:w-[70vw] md:min-w-[360px]"
        }
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.pointerType === "mouse" && poke()}
        onPointerDown={poke}
        onMouseLeave={() => playing && setControlsShown(false)}
      >
        {/* Кадр */}
        {failed ? (
          <ErrorView compact={false} />
        ) : (
          <video
            {...mediaProps}
            className={
              immersive
                ? "h-full w-full bg-black object-contain"
                : "max-h-[calc(100vh-1rem)] min-h-[220px] w-full bg-black object-contain md:max-h-[80vh] md:min-h-[300px]"
            }
            onClick={() => {
              if (!controlsShown) return; // первый тап по скрытым контролам — только показать их
              togglePlay();
            }}
          >
            {subTrack}
          </video>
        )}

        {/* Верх: название и закрыть */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent px-3 pb-10 pt-2.5 text-white md:px-4 ${layer}`}
        >
          <div className="min-w-0 pt-1">
            <h3 className="truncate text-sm font-semibold tracking-tight">{video.title}</h3>
            {video.platform && <p className="truncate text-[11px] font-semibold text-white/60">{video.platform}</p>}
          </div>
          {!immersive && (
            <button onClick={onClose} title={t("player.close")} aria-label={t("player.close")} className={`pointer-events-auto ${btn}`}>
              <X className={ic} strokeWidth={2.25} />
            </button>
          )}
        </div>

        {/* Низ: один ряд — транспорт, время с перемоткой, остальные кнопки */}
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-12 text-white md:px-3 md:pb-2 ${layer}`}
        >
          <div className="flex items-center gap-0.5">
            {queue.length > 1 && (
              <button onClick={() => prevVideo && onChange(prevVideo)} disabled={!prevVideo} title={`${t("player.prev")} (P)`} aria-label={t("player.prev")} className={btn}>
                <SkipBack className={`${ic} fill-current`} strokeWidth={2.25} />
              </button>
            )}
            <button onClick={() => skip(-skipSec)} title={`${t("player.back", { n: skipSec })} (←)`} aria-label={t("player.backAria")} className={btn}>
              <Rewind className={ic} strokeWidth={2.25} />
            </button>
            <button
              onClick={togglePlay}
              aria-label={playing ? t("player.pause") : t("player.play")}
              className="mx-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-md transition-transform hover:scale-105 active:scale-95"
            >
              {playing ? (
                <Pause className={`${ic} fill-current`} strokeWidth={2.25} />
              ) : (
                <Play className={`${ic} translate-x-[1px] fill-current`} strokeWidth={2.25} />
              )}
            </button>
            <button onClick={() => skip(skipSec)} title={`${t("player.forward", { n: skipSec })} (→)`} aria-label={t("player.forwardAria")} className={btn}>
              <FastForward className={ic} strokeWidth={2.25} />
            </button>
            {queue.length > 1 && (
              <button onClick={() => nextVideo && onChange(nextVideo)} disabled={!nextVideo} title={`${t("player.next")} (N)`} aria-label={t("player.next")} className={btn}>
                <SkipForward className={`${ic} fill-current`} strokeWidth={2.25} />
              </button>
            )}

            {/* Громкость — на телефоне её меняют кнопки, поэтому только на компьютере. */}
            {!IS_ANDROID && (
              <div className="group/vol flex items-center">
                <button onClick={toggleMute} title={`${t("player.sound")} (M)`} aria-label={t("player.sound")} className={btn}>
                  <VolIcon className={ic} strokeWidth={2.25} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => applyVolume(Number(e.target.value))}
                  title={`${t("player.volume")} (↑/↓)`}
                  aria-label={t("player.volume")}
                  className="hidden h-1 w-0 cursor-pointer appearance-none rounded-full opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 focus:w-20 focus:opacity-100 md:block"
                  style={{
                    background: `linear-gradient(to right, #fff ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.28) 0%)`,
                  }}
                />
              </div>
            )}

            {/* Время и перемотка — между транспортом и правыми кнопками */}
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 md:gap-3">
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-white/80">{formatDuration(time)}</span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={time}
                onChange={seek}
                aria-label={t("player.seek")}
                // min-w-0: у range своя минимальная ширина — без этого на телефоне ряд уезжал за край.
                className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
                style={{
                  background: `linear-gradient(to right, #fff ${duration ? (time / duration) * 100 : 0}%, rgba(255,255,255,0.28) 0%)`,
                }}
              />
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-white/80">{formatDuration(duration)}</span>
            </div>

            {!immersive && (
              <button onClick={() => openPath(video.file_path).catch(() => {})} title={t("player.external")} aria-label={t("player.externalAria")} className={btn}>
                <ExternalLink className={ic} strokeWidth={2.25} />
              </button>
            )}
            {/* Отдельных окон на Android нет. */}
            {!IS_ANDROID && (
              <button
                onClick={() => {
                  openMiniWindow(video);
                  onClose();
                }}
                title={t("player.miniWindow")}
                aria-label={t("player.miniWindow")}
                className={btn}
              >
                <PictureInPicture2 className={ic} strokeWidth={2.25} />
              </button>
            )}
            <button onClick={toggleFullscreen} title={`${t("player.fullscreen")} (F)`} aria-label={t("player.fullscreen")} className={btn}>
              {immersive ? <Minimize className={ic} strokeWidth={2.25} /> : <Maximize className={ic} strokeWidth={2.25} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
