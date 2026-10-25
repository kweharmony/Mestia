import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IS_ANDROID } from "./platform";

/**
 * Адрес локального файла для <audio>/<video>. Android — через свой HTTP на 127.0.0.1
 * (media.rs): asset:// там отвечает на Range кусками по 1 МБ, и аудио больше 1 МБ
 * не загружается. На компьютере — обычный asset://.
 */
export function mediaSrc(path: string): Promise<string> {
  if (!IS_ANDROID) return Promise.resolve(convertFileSrc(path));
  return invoke<string>("local_media_url", { path }).catch(() => convertFileSrc(path));
}

/** То же для рендера: undefined, пока адрес не готов (на Android — доли секунды). */
export function useMediaSrc(path: string | null | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() =>
    path && !IS_ANDROID ? convertFileSrc(path) : undefined
  );
  useEffect(() => {
    if (!path) return setSrc(undefined);
    let alive = true;
    mediaSrc(path).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [path]);
  return src;
}

/** Android: что-то играет — служба держит процессор и Wi-Fi, экран можно выключить. */
export function setPlaybackActive(on: boolean): void {
  if (IS_ANDROID) invoke("set_playback_active", { on }).catch(() => {});
}

/** Что играет — для системной медиапанели (Android: уведомление, ПК: медиа-оверлей ОС). */
export interface NowPlaying {
  title: string;
  artist?: string | null;
  /** Обложка: путь к файлу или http(s); нет — Android возьмёт кадр/обложку из файла. */
  artwork?: string | null;
  path: string;
  duration: number; // секунды
  position: number; // секунды
  playing: boolean;
  rate: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export type MediaAction = { action: "play" | "pause" | "next" | "prev" | "seek"; position?: number };

/**
 * Показать/обновить медиапанель (null — плеер закрыт). На Android это ещё и служба
 * воспроизведения: пока играет, телефон не усыпляет процессор и Wi-Fi.
 */
export function setNowPlaying(np: NowPlaying | null): void {
  if (IS_ANDROID) {
    invoke("media_session", { state: np ? { ...np, active: true } : null }).catch(() => {});
    return;
  }
  const ms = navigator.mediaSession;
  if (!ms) return;
  if (!np) {
    ms.metadata = null;
    ms.playbackState = "none";
    return;
  }
  const art = np.artwork ? (/^https?:/i.test(np.artwork) ? np.artwork : convertFileSrc(np.artwork)) : null;
  ms.metadata = new MediaMetadata({
    title: np.title,
    artist: np.artist ?? "Mestia",
    artwork: art ? [{ src: art }] : [],
  });
  ms.playbackState = np.playing ? "playing" : "paused";
}

/** Кнопки медиапанели/гарнитуры/медиа-клавиш. Возвращает отписку. */
export function onMediaAction(cb: (a: MediaAction) => void): () => void {
  if (IS_ANDROID) {
    const un = listen<MediaAction>("media://action", (e) => cb(e.payload));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }
  const ms = navigator.mediaSession;
  if (!ms) return () => {};
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => cb({ action: "play" })],
    ["pause", () => cb({ action: "pause" })],
    ["nexttrack", () => cb({ action: "next" })],
    ["previoustrack", () => cb({ action: "prev" })],
    ["seekto", (d) => cb({ action: "seek", position: d.seekTime })],
  ];
  for (const [a, h] of handlers) {
    try {
      ms.setActionHandler(a, h);
    } catch {
      // действие не поддерживается движком
    }
  }
  return () => {
    for (const [a] of handlers) {
      try {
        ms.setActionHandler(a, null);
      } catch {
        // см. выше
      }
    }
  };
}
