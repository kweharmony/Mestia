import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isPermissionGranted,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  cancelDownload as ipcCancel,
  createFolderOnDisk,
  getSetting,
  onDone,
  onItem,
  onProgress,
  startDownload as ipcStartDownload,
} from "../lib/ipc";
import {
  createFolder,
  findFolderByPath,
  insertHistory,
  insertVideo,
  markInterrupted,
  updateHistoryStatus,
} from "../lib/db";
import { useToast } from "../components/Toast";

export type DownloadStatus = "downloading" | "queued" | "done" | "error" | "cancelled";

export interface ActiveDownload {
  id: string;
  title: string;
  isPlaylist: boolean;
  percent: number;
  index: number | null;
  totalItems: number | null;
  doneCount: number;
  status: DownloadStatus;
  error?: string;
}

export interface StartOpts {
  url: string;
  format: string;
  isAudio: boolean;
  audioFormat: string | null;
  mode: "single" | "all" | "range";
  items: string | null;
  meta: {
    title: string;
    platform: string | null;
    webpage_url: string | null;
    isPlaylist: boolean;
  };
  // Для возобновления/перезапуска прерванной загрузки:
  outDir?: string | null;
  folderId?: number | null;
  historyId?: number;
  recovery?: "resume" | "restart";
}

interface DownloadsCtx {
  downloads: ActiveDownload[];
  hasActive: boolean;
  /** Растёт при каждом добавлении видео в библиотеку — для живого обновления Медиатеки. */
  libraryVersion: number;
  start: (opts: StartOpts) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
}

const Ctx = createContext<DownloadsCtx | null>(null);

type Meta = {
  folderId: number | null;
  historyId: number;
  isPlaylist: boolean;
  lastTotal: number | null;
};

/** Параметры invoke, отложенные в очередь до освобождения слота. */
type QueuedInvoke = Parameters<typeof ipcStartDownload>[0];

async function maxParallel(): Promise<number> {
  const v = parseInt((await getSetting("maxParallel").catch(() => null)) ?? "2", 10);
  return Number.isNaN(v) ? 2 : Math.min(5, Math.max(1, v));
}

async function notifyDesktop(title: string, body: string) {
  try {
    if ((await getSetting("notifications")) !== "1") return;
    if (await isPermissionGranted()) sendNotification({ title, body });
  } catch {
    /* уведомления необязательны */
  }
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { notify } = useToast();
  const [downloads, setDownloads] = useState<ActiveDownload[]>([]);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const metaMap = useRef(new Map<string, Meta>());
  const queueRef = useRef<QueuedInvoke[]>([]);

  // Зеркало downloads для колбэков без пересоздания подписок.
  const downloadsRef = useRef<ActiveDownload[]>([]);
  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  // При старте помечаем зависшие «downloading» как прерванные.
  useEffect(() => {
    markInterrupted().catch(() => {});
  }, []);

  function setStatus(id: string, patch: Partial<ActiveDownload>) {
    setDownloads((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  /** Запускает задачи из очереди, пока есть свободные слоты. */
  async function pumpQueue() {
    const limit = await maxParallel();
    while (queueRef.current.length > 0) {
      const active = downloadsRef.current.filter((d) => d.status === "downloading").length;
      const queuedShown = downloadsRef.current.filter((d) => d.status === "queued").length;
      // active считаем по ref + только что запущенные ещё могут не отразиться;
      // защищаемся минимально: выходим, если слотов нет.
      if (active >= limit) break;
      const next = queueRef.current.shift();
      if (!next) break;
      setStatus(next.id, { status: "downloading" });
      downloadsRef.current = downloadsRef.current.map((d) =>
        d.id === next.id ? { ...d, status: "downloading" } : d
      );
      void queuedShown;
      ipcStartDownload(next).catch((e) => {
        const m = metaMap.current.get(next.id);
        if (m?.historyId) void updateHistoryStatus(m.historyId, "error", null);
        metaMap.current.delete(next.id);
        setStatus(next.id, { status: "error", error: String(e) });
      });
    }
  }

  // Глобальные слушатели событий загрузки — один раз.
  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const reg = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unsubs.push(u)));

    reg(
      onProgress((p) => {
        const m = metaMap.current.get(p.id);
        if (m) m.lastTotal = p.total ?? m.lastTotal;
        setDownloads((ds) =>
          ds.map((d) =>
            d.id === p.id && d.status === "downloading"
              ? { ...d, percent: p.percent, index: p.index, totalItems: p.total_items }
              : d
          )
        );
      })
    );

    reg(
      onItem(async (it) => {
        const m = metaMap.current.get(it.id);
        if (!m) return; // отменённая задача — файл не регистрируем
        await insertVideo({
          title: it.title,
          url: it.url,
          file_path: it.filePath,
          duration: it.duration,
          size: !m.isPlaylist ? m.lastTotal : null,
          thumbnail_path: it.thumbnail,
          platform: it.platform,
          folder_id: m.folderId,
        });
        setDownloads((ds) =>
          ds.map((d) => (d.id === it.id ? { ...d, doneCount: d.doneCount + 1 } : d))
        );
        setLibraryVersion((v) => v + 1);
      })
    );

    reg(
      onDone(async (d) => {
        const m = metaMap.current.get(d.id);
        if (m?.historyId) {
          await updateHistoryStatus(m.historyId, d.ok ? "success" : "error", null);
        }
        metaMap.current.delete(d.id);
        // Не трогаем задачи, отменённые пользователем.
        setDownloads((ds) =>
          ds.map((x) =>
            x.id === d.id && x.status === "downloading"
              ? { ...x, status: d.ok ? "done" : "error", error: d.error ?? undefined }
              : x
          )
        );
        setLibraryVersion((v) => v + 1);
        const task = downloadsRef.current.find((x) => x.id === d.id);
        if (task && task.status === "downloading") {
          if (d.ok) {
            notify(`Готово: ${task.title}`);
            void notifyDesktop("Mestia — загрузка завершена", task.title);
          } else {
            notify(`Ошибка: ${task.title}`, "error");
            void notifyDesktop("Mestia — ошибка загрузки", task.title);
          }
        }
        void pumpQueue();
      })
    );

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(opts: StartOpts) {
    const id = crypto.randomUUID();
    let folderId: number | null = opts.folderId ?? null;
    let outDir: string | null = opts.outDir ?? null;

    try {
      if (opts.meta.isPlaylist) {
        if (outDir) {
          folderId =
            folderId ??
            (await findFolderByPath(outDir)) ??
            (await createFolder(opts.meta.title, outDir, null));
        } else {
          outDir = await createFolderOnDisk(opts.meta.title, null);
          folderId = await createFolder(opts.meta.title, outDir, null);
        }
      }

      let historyId = opts.historyId ?? 0;
      if (historyId) {
        await updateHistoryStatus(historyId, "downloading", null);
      } else {
        historyId = await insertHistory({
          title: opts.meta.isPlaylist ? `Плейлист: ${opts.meta.title}` : opts.meta.title,
          url: opts.meta.webpage_url ?? opts.url,
          status: "downloading",
          file_size: null,
          platform: opts.meta.platform,
          format: opts.format,
          is_audio: opts.isAudio,
          audio_format: opts.audioFormat,
          mode: opts.mode,
          items: opts.items,
          out_dir: outDir,
        });
      }

      metaMap.current.set(id, {
        folderId,
        historyId,
        isPlaylist: opts.meta.isPlaylist,
        lastTotal: null,
      });

      const invokeArgs: QueuedInvoke = {
        id,
        url: opts.url,
        format: opts.format,
        isAudio: opts.isAudio,
        audioFormat: opts.audioFormat,
        mode: opts.mode,
        items: opts.items,
        outDir,
        recovery: opts.recovery ?? null,
      };

      const limit = await maxParallel();
      const active = downloadsRef.current.filter((x) => x.status === "downloading").length;
      const willQueue = active >= limit;

      setDownloads((ds) => [
        ...ds,
        {
          id,
          title: opts.meta.title,
          isPlaylist: opts.meta.isPlaylist,
          percent: 0,
          index: null,
          totalItems: null,
          doneCount: 0,
          status: willQueue ? "queued" : "downloading",
        },
      ]);

      if (willQueue) {
        queueRef.current.push(invokeArgs);
      } else {
        await ipcStartDownload(invokeArgs);
      }
    } catch (e) {
      const m = metaMap.current.get(id);
      if (m?.historyId) await updateHistoryStatus(m.historyId, "error", null);
      metaMap.current.delete(id);
      setStatus(id, { status: "error", error: String(e) });
      notify("Ошибка запуска загрузки", "error");
    }
  }

  /** Отменить загрузку (активную — убить процесс, очередную — убрать из очереди). */
  async function cancel(id: string) {
    const task = downloadsRef.current.find((d) => d.id === id);
    if (!task) return;

    const m = metaMap.current.get(id);
    metaMap.current.delete(id); // дальнейшие события по этой задаче игнорируются

    if (task.status === "queued") {
      queueRef.current = queueRef.current.filter((q) => q.id !== id);
    } else if (task.status === "downloading") {
      await ipcCancel(id).catch(() => {});
    }
    if (m?.historyId) await updateHistoryStatus(m.historyId, "interrupted", null);
    setStatus(id, { status: "cancelled" });
    setLibraryVersion((v) => v + 1); // обновить статусы в Истории
    notify("Загрузка отменена");
    void pumpQueue();
  }

  function dismiss(id: string) {
    setDownloads((ds) => ds.filter((d) => d.id !== id));
  }

  const hasActive = downloads.some(
    (d) => d.status === "downloading" || d.status === "queued"
  );

  return (
    <Ctx.Provider value={{ downloads, hasActive, libraryVersion, start, cancel, dismiss }}>
      {children}
    </Ctx.Provider>
  );
}

export function useDownloads(): DownloadsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDownloads должен использоваться внутри DownloadsProvider");
  return ctx;
}
