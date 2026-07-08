import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVideoById, listVideos } from "../lib/db";
import type { VideoRow } from "../types";
import { useI18n } from "../context/LanguageContext";
import Player from "./Player";

/** Содержимое отдельного плавающего окна плеера (?mini=<id>). */
export default function MiniPlayer({ id }: { id: number }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState<VideoRow | null>(null);
  const [queue, setQueue] = useState<VideoRow[]>([]);

  useEffect(() => {
    getVideoById(id)
      .then(async (v) => {
        if (!v) return;
        setCurrent(v);
        const q = await listVideos(v.folder_id);
        setQueue(q.length ? q : [v]);
        getCurrentWindow().setTitle(v.title).catch(() => {});
      })
      .catch(() => {});
  }, [id]);

  if (!current) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-snow text-sm font-semibold text-smoke">
        {t("player.loading")}
      </div>
    );
  }

  return (
    <Player
      embedded
      video={current}
      queue={queue}
      onChange={setCurrent}
      onClose={() => getCurrentWindow().close()}
    />
  );
}
