import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
