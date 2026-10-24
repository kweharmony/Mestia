import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Maximize2,
  ListPlus,
  ListVideo,
  Loader2,
  Maximize,
  Minimize,
  Music,
  Pause,
  Play,
  SkipForward,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useLan, type LanRoom } from "../context/LanContext";
import { useI18n } from "../context/LanguageContext";
import { useToast } from "../components/Toast";
import LibraryPicker from "../components/LibraryPicker";
import Modal from "../components/Modal";
import {
  formatDuration,
  isAudioPath,
  lanRoomCmd,
  lanRoomMove,
  lanRoomPlay,
  lanRoomQueue,
  lanRoomRemove,
  lanRoomState,
  setFullscreen,
  type QueueItem,
  type RoomQueue,
  type RoomState,
} from "../lib/ipc";
import { PLAY_LEAD, expectedPos, nextLead, syncStep } from "../lib/roomSync";
import { IS_ANDROID } from "../lib/platform";
import { setPlaybackActive, useMediaSrc } from "../lib/media";

/**
 * Совместный просмотр с очередью. Ведущий играет текущий элемент и рассылает состояние
 * (play/pause/позиция); по окончании сам включает следующий — у гостей он меняется
 * автоматически. Гость подстраивается под ведущего: крупный разрыв — перемотка, мелкий —
 * незаметное изменение скорости. Кнопки гостя отправляют команду ведущему, а свои файлы
 * гость может предложить в очередь (играют с его устройства).
 */
export default function Room({ room }: { room: LanRoom }) {
  const { t } = useI18n();
  const { notify } = useToast();
  const { closeRoom, queueFiles, roomMinimized, setRoomMinimized } = useLan();
  const ref = useRef<HTMLVideoElement>(null);
  const host = room.role === "host";

  const [queue, setQueue] = useState<RoomQueue | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [guests, setGuests] = useState<string[]>([]);
  const [peers, setPeers] = useState(1);
  const [picking, setPicking] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // Гость: autoplay без жеста пользователя WebView может запретить — просим нажать один раз.
  const [needTap, setNeedTap] = useState(false);
  const [waiting, setWaiting] = useState(!host);
  const target = useRef<RoomState | null>(null);
  // Полный экран — для блока «видео + свои кнопки» (не для <video>: у гостя родные
  // контролы управляли бы только его плеером). Android — свой режим, как в Player.
  const stageRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<null | { landscape: boolean }>(null);
  const [controlsShown, setControlsShown] = useState(true);
  const [pokeTick, setPokeTick] = useState(0);

  const cur: QueueItem | null = queue?.items.find((i) => i.id === queue.current) ?? null;
  const curId = cur?.id ?? null;
  const curRef = useRef<string | null>(null);
  curRef.current = curId;
  // Свой файл ведущего — локально (на Android через media.rs), чужой — поток по сети.
  const localPath = cur ? cur.path : room.role === "host" ? room.video.file_path : null;
  const localSrc = useMediaSrc(localPath);
  const src = localPath ? localSrc : cur?.url ?? undefined;
  const title = cur?.title ?? (room.role === "host" ? room.video.title : room.title);
  const audio = cur ? cur.kind === "audio" : room.role === "host" ? isAudioPath(room.video.file_path) : room.kind === "audio";
  const idx = queue && cur ? queue.items.findIndex((i) => i.id === cur.id) : -1;
  const next = queue && idx >= 0 ? queue.items[idx + 1] ?? null : null;

  // Вышли из комнаты — телефону снова можно засыпать.
  useEffect(() => () => setPlaybackActive(false), []);

  // Очередь: начальная (могла прийти до монтирования) + обновления.
  useEffect(() => {
    lanRoomQueue().then((q) => q && setQueue(q)).catch(() => {});
    const sub = listen<RoomQueue>("lan://room-queue", (e) => setQueue(e.payload));
    return () => {
      sub.then((u) => u());
    };
  }, []);

  // Смена элемента: ведущий запускает новый файл сам, гость ждёт состояния для него.
  const autoplay = useRef(false);
  const prevId = useRef<string | null>(null);
  useEffect(() => {
    if (prevId.current !== null && curId !== prevId.current) {
      if (host) autoplay.current = true;
      else {
        target.current = null;
        setWaiting(true);
      }
      setTime(0);
    }
    prevId.current = curId;
  }, [curId, host]);

  // ── Ведущий: рассылаем состояние на каждое изменение и раз в секунду (для дрейфа).
  useEffect(() => {
    if (!host) return;
    const el = ref.current;
    if (!el) return;
    let buffering = false;
    const send = () =>
      lanRoomState(!el.paused && !buffering, el.currentTime, el.playbackRate).catch(() => {});
    const onWait = () => {
      buffering = true;
      send();
    };
    const onPlaying = () => {
      buffering = false;
      send();
    };
    const onMeta = () => {
      if (autoplay.current) {
        autoplay.current = false;
        el.play().catch(() => {});
      }
      send();
    };
    const events = ["play", "pause", "seeked", "ratechange"];
    events.forEach((ev) => el.addEventListener(ev, send));
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("waiting", onWait);
    el.addEventListener("playing", onPlaying);
    const iv = window.setInterval(send, 1000);
    const subs = [
      listen<{ action: string; pos: number }>("lan://room-cmd", (e) => {
        const { action, pos } = e.payload;
        if (action === "play") el.play().catch(() => {});
        else if (action === "pause") el.pause();
        else if (action === "seek" && Number.isFinite(pos)) el.currentTime = pos;
      }),
      listen<string[]>("lan://room-guests", (e) => setGuests(e.payload)),
    ];
    return () => {
      events.forEach((ev) => el.removeEventListener(ev, send));
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("waiting", onWait);
      el.removeEventListener("playing", onPlaying);
      window.clearInterval(iv);
      subs.forEach((s) => s.then((u) => u()));
    };
  }, [host]);

  // ── Гость: принимаем состояние ведущего и каждые 250 мс подтягиваемся к нему.
  useEffect(() => {
    if (host) return;
    const el = ref.current;
    if (!el) return;
    const subs = [
      listen<RoomState>("lan://room-state", (e) => {
        // Состояние прошлого/следующего элемента (на стыке переключения) — пропускаем.
        if (e.payload.item && e.payload.item !== curRef.current) return;
        target.current = e.payload;
        setPeers(e.payload.peers);
        setWaiting(false);
      }),
      listen("lan://room-end", () => {
        notify(t("room.ended"), "error");
        closeRoom();
      }),
    ];
    // Пока play() стартует (буферизация после перемотки), новые шаги его бы сбивали.
    let starting = false;
    let lead = PLAY_LEAD;
    const iv = window.setInterval(() => {
      const s = target.current;
      if (!s || el.readyState < 1 || starting) return;
      const step = syncStep(s, Date.now(), el.currentTime, el.paused, lead);
      if (step.play) {
        starting = true;
        if (step.seek !== null) el.currentTime = step.seek;
        el.playbackRate = step.rate;
        el.play()
          .then(() => setNeedTap(false))
          .catch(() => setNeedTap(true))
          .finally(() => {
            starting = false;
            // Через полсекунды после старта смотрим промах и учимся на нём.
            window.setTimeout(() => {
              const cur = target.current;
              if (!cur?.playing || el.paused) return;
              lead = nextLead(lead, el.currentTime - expectedPos(cur, Date.now()));
            }, 500);
          });
        return;
      }
      if (step.pause) el.pause();
      if (step.seek !== null) el.currentTime = step.seek;
      el.playbackRate = step.rate;
    }, 250);
    return () => {
      window.clearInterval(iv);
      subs.forEach((s) => s.then((u) => u()));
    };
  }, [host, notify, t, closeRoom]);

  function togglePlay() {
    const el = ref.current;
    if (!el) return;
    if (host) {
      if (el.paused) el.play().catch(() => {});
      else el.pause();
    } else {
      lanRoomCmd(target.current?.playing ? "pause" : "play", el.currentTime).catch(() => {});
    }
  }

  function seek(pos: number) {
    const el = ref.current;
    if (!el) return;
    if (host) el.currentTime = pos;
    else lanRoomCmd("seek", pos).catch(() => {});
    setTime(pos);
  }

  // Ведущий: файл кончился — следующий в очереди у всех.
  function onEnded() {
    if (host && next) lanRoomPlay(next.id).catch(() => {});
  }

  function toggleFull() {
    const el = ref.current;
    if (!el) return;
    if (IS_ANDROID) {
      setFull((f) => (f ? null : { landscape: el.videoWidth >= el.videoHeight }));
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stageRef.current?.requestFullscreen?.().catch(() => {});
  }

  function poke() {
    setControlsShown(true);
    setPokeTick((n) => n + 1);
  }

  function unlock() {
    ref.current?.play().then(() => setNeedTap(false)).catch(() => {});
  }

  async function addPicked(paths: { file_path: string; title: string }[]) {
    setPicking(false);
    await queueFiles(paths);
  }

  // Компьютер: состояние берём из Fullscreen API (выход — и по Esc).
  useEffect(() => {
    if (IS_ANDROID) return;
    const onChange = () => setFull(document.fullscreenElement ? { landscape: true } : null);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Android: нативная часть (панели, поворот, экран не гаснет); «Назад» — выход из режима.
  useEffect(() => {
    if (!IS_ANDROID || !full) return;
    setFullscreen(true, full.landscape).catch(() => {});
    const onBack = (e: Event) => {
      e.preventDefault();
      setFull(null);
    };
    window.addEventListener("mestia:back", onBack);
    return () => {
      window.removeEventListener("mestia:back", onBack);
      setFullscreen(false, true).catch(() => {});
    };
  }, [full]);

  // Android: телефон повернули горизонтально — видео сразу на весь экран, как в плеере.
  useEffect(() => {
    if (!IS_ANDROID || audio) return;
    const mq = window.matchMedia("(orientation: landscape)");
    const onChange = () => {
      if (mq.matches) setFull((f) => f ?? { landscape: true });
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [audio]);

  // В полном экране кнопки прячутся через 4 с без касаний (на паузе — видны).
  useEffect(() => {
    if (!full || !playing) {
      setControlsShown(true);
      return;
    }
    const tm = window.setTimeout(() => setControlsShown(false), 4000);
    return () => window.clearTimeout(tm);
  }, [full, playing, pokeTick]);

  const trackRest = full ? "rgba(255,255,255,0.3)" : "var(--c-fog)";
  const btnCls = full ? "rounded-ui p-1.5 text-white/80 hover:bg-white/10 hover:text-white" : "rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink";
  const timeCls = full ? "text-white/80" : "text-smoke";

  return (
    <>
    {/* Свёрнута — плеер остаётся на странице (звук идёт), видна только плашка. */}
    <div
      className={`fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm md:p-8 ${
        roomMinimized && !full ? "hidden" : ""
      }`}
    >
      {/* В полном экране без анимации: transform предка сломал бы fixed у сцены. */}
      <div
        className={`${full ? "" : "mestia-fade-in "}flex max-h-full w-full max-w-[960px] flex-col overflow-hidden rounded-ui border-2 border-ink bg-snow`}
      >
        {/* Шапка */}
        <div className="flex items-center justify-between gap-3 border-b-2 border-fog px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-smoke">
              <Users className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
              <span className="truncate">
                {host
                  ? guests.length
                    ? t("room.hostWith", { names: guests.join(", ") })
                    : t("room.hostAlone")
                  : t("room.guestOf", { host: room.host, n: peers })}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setRoomMinimized(true)}
              title={t("room.minimize")}
              className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
            >
              <ChevronDown className="h-5 w-5" strokeWidth={2.25} />
            </button>
            <button
              onClick={closeRoom}
              title={host ? t("room.close") : t("room.leave")}
              className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
            >
              <X className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </div>
        </div>

        {/* Сцена: видео + управление (это и уходит в полный экран) */}
        <div
          ref={stageRef}
          onPointerDown={full ? poke : undefined}
          className={full ? "fixed inset-0 z-50 flex flex-col bg-black" : "flex shrink-0 flex-col"}
        >
        {/* Видео / обложка аудио */}
        <div className={`relative flex items-center justify-center bg-black ${full ? "min-h-0 flex-1" : "min-h-[180px]"}`}>
          <video
            ref={ref}
            src={src}
            playsInline
            preload="auto"
            muted={muted}
            onClick={() => {
              if (full && !controlsShown) return poke();
              togglePlay();
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
            onPlay={() => {
              setPlaying(true);
              setPlaybackActive(true);
            }}
            onPause={() => {
              setPlaying(false);
              setPlaybackActive(false);
            }}
            onEnded={onEnded}
            onError={() => notify(t("room.mediaError"), "error")}
            className={audio ? "hidden" : full ? "h-full w-full object-contain" : "max-h-[60vh] w-full object-contain"}
          />
          {audio && (
            <div className="flex flex-col items-center gap-3 py-14 text-white/80">
              <Music className="h-14 w-14" strokeWidth={1.75} />
              <span className="max-w-[80%] truncate text-sm font-semibold">{title}</span>
            </div>
          )}
          {waiting && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm font-semibold text-white">
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.25} />
              {t("room.syncing")}
            </div>
          )}
          {needTap && (
            <button
              onClick={unlock}
              className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-semibold text-white"
            >
              <span className="flex items-center gap-2 rounded-ui bg-accent px-4 py-2">
                <Play className="h-4 w-4" strokeWidth={2.25} />
                {t("room.tapToJoin")}
              </span>
            </button>
          )}
        </div>

        {/* Управление */}
        <div
          className={`flex shrink-0 items-center gap-3 px-4 py-3 transition-opacity ${
            full
              ? `absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent pb-5 pt-10 ${
                  controlsShown ? "opacity-100" : "pointer-events-none opacity-0"
                }`
              : ""
          }`}
        >
          <button
            onClick={togglePlay}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:opacity-90"
          >
            {playing ? <Pause className="h-4 w-4" strokeWidth={2.5} /> : <Play className="h-4 w-4" strokeWidth={2.5} />}
          </button>
          {host && next && (
            <button
              onClick={() => lanRoomPlay(next.id).catch(() => {})}
              title={t("room.next")}
              className={btnCls}
            >
              <SkipForward className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
          <span className={`shrink-0 text-xs font-semibold tabular-nums ${timeCls}`}>
            {formatDuration(time)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            // Дорожку рисуем сами: WebView на Android у appearance:none её не показывает.
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, var(--c-accent) ${
                duration ? (Math.min(time, duration) / duration) * 100 : 0
              }%, ${trackRest} 0%)`,
            }}
          />
          <span className={`shrink-0 text-xs font-semibold tabular-nums ${timeCls}`}>
            {formatDuration(duration)}
          </span>
          <button
            onClick={() => setQueueOpen(true)}
            title={t("room.queue")}
            className={`relative ${btnCls}`}
          >
            <ListVideo className="h-4 w-4" strokeWidth={2.25} />
            {(queue?.items.length ?? 0) > 1 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                {queue?.items.length}
              </span>
            )}
          </button>
          <button onClick={() => setMuted((m) => !m)} className={btnCls}>
            {muted ? <VolumeX className="h-4 w-4" strokeWidth={2.25} /> : <Volume2 className="h-4 w-4" strokeWidth={2.25} />}
          </button>
          {!audio && (
            <button onClick={toggleFull} title={t("player.fullscreen")} className={btnCls}>
              {full ? <Minimize className="h-4 w-4" strokeWidth={2.25} /> : <Maximize className="h-4 w-4" strokeWidth={2.25} />}
            </button>
          )}
        </div>
        </div>
      </div>

      {/* Очередь — всплывающим окном по кнопке (видео не теряет места). */}
      <Modal
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        z={60}
        cardClassName="mestia-anim flex max-h-[80vh] w-full max-w-[480px] flex-col gap-3 rounded-ui border-2 border-ink bg-snow p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <ListVideo className="h-5 w-5 text-accent" strokeWidth={2.25} />
            {t("room.queue")}
            <span className="text-sm text-smoke">{queue?.items.length ?? 0}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setQueueOpen(false);
                setPicking(true);
              }}
              className="flex items-center gap-1.5 rounded-ui border-2 border-ink px-3 py-1 text-xs font-semibold hover:bg-fog"
            >
              <ListPlus className="h-4 w-4" strokeWidth={2.25} />
              {host ? t("room.add") : t("room.propose")}
            </button>
            <button onClick={() => setQueueOpen(false)} className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink">
              <X className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </div>
        </div>
          <ol className="-mx-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {(queue?.items ?? []).map((it, i) => {
              const isCur = it.id === curId;
              return (
                <li
                  key={it.id}
                  ref={isCur ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  className={`flex items-center gap-2 rounded-ui px-2 py-1.5 text-sm font-semibold ${
                    isCur ? "bg-fog" : ""
                  }`}
                >
                  <span className="flex w-6 shrink-0 justify-center text-xs text-smoke">
                    {isCur ? <Play className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`line-clamp-2 break-words leading-snug ${isCur ? "text-accent" : ""}`}>{it.title}</span>
                    {it.by && (
                      <span className="block truncate text-[11px] text-smoke">{t("room.proposedBy", { name: it.by })}</span>
                    )}
                  </span>
                  {host && (
                    <span className="flex shrink-0 items-center">
                      {!isCur && (
                        <button
                          onClick={() => lanRoomPlay(it.id)}
                          title={t("room.playNow")}
                          className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
                        >
                          <Play className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </button>
                      )}
                      <button
                        onClick={() => lanRoomMove(it.id, -1)}
                        disabled={i === 0}
                        title={t("room.up")}
                        className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                      <button
                        onClick={() => lanRoomMove(it.id, 1)}
                        disabled={i === (queue?.items.length ?? 0) - 1}
                        title={t("room.down")}
                        className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                      <button
                        onClick={() => lanRoomRemove(it.id)}
                        disabled={isCur}
                        title={t("room.remove")}
                        className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-rose-500 disabled:opacity-30"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
            {queue && !next && (
              <li className="px-2 pt-1 text-xs font-semibold text-smoke">
                {host ? t("room.queueEndHost") : t("room.queueEndGuest")}
              </li>
            )}
          </ol>
      </Modal>

      <LibraryPicker
        open={picking}
        multi
        title={host ? t("room.addTitle") : t("room.proposeTitle")}
        hint={host ? t("room.addHint") : t("room.proposeHint")}
        action={(n) => (host ? t("room.addN", { n }) : t("room.proposeN", { n }))}
        onClose={() => setPicking(false)}
        onPick={(videos) => void addPicked(videos)}
      />
    </div>

    {/* Плашка свёрнутой комнаты: над нижней панелью вкладок (на телефоне) и панелью выбора. */}
    {roomMinimized && !full && (
      <div className="mestia-fade-in fixed bottom-[9.5rem] right-3 z-40 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-ui border-2 border-ink bg-snow py-1.5 pl-3 pr-1.5 shadow-lg md:bottom-6 md:right-6">
        {audio ? (
          <Music className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.25} />
        ) : (
          <ListVideo className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.25} />
        )}
        <button
          onClick={() => setRoomMinimized(false)}
          className="min-w-0 max-w-[220px] text-left text-xs font-semibold"
        >
          <span className="block truncate">{title}</span>
          <span className="block truncate text-[11px] text-smoke">
            {host ? t("room.minimizedHost") : t("room.minimizedGuest", { host: room.host })}
          </span>
        </button>
        <button
          onClick={togglePlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:opacity-90"
        >
          {playing ? <Pause className="h-4 w-4" strokeWidth={2.5} /> : <Play className="h-4 w-4" strokeWidth={2.5} />}
        </button>
        <button
          onClick={() => setRoomMinimized(false)}
          title={t("room.expand")}
          className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
        >
          <Maximize2 className="h-4 w-4" strokeWidth={2.25} />
        </button>
      </div>
    )}
    </>
  );
}
