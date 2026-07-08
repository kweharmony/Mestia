import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  FolderOpen,
  Loader2,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { clearHistory, deleteHistoryRow, findVideoByUrl, listHistory } from "../lib/db";
import { formatBytes, humanizeError, revealInExplorer } from "../lib/ipc";
import type { HistoryRow, VideoRow } from "../types";
import { useToast } from "../components/Toast";
import { useDownloads } from "../context/DownloadsContext";
import { useI18n } from "../context/LanguageContext";

interface HistoryProps {
  onPlay: (v: VideoRow) => void;
  onGoToDownloader: () => void;
}

export default function History({ onPlay, onGoToDownloader }: HistoryProps) {
  const { notify } = useToast();
  const { start, libraryVersion } = useDownloads();
  const { t } = useI18n();
  const [rows, setRows] = useState<HistoryRow[]>([]);

  async function refresh() {
    setRows(await listHistory());
  }

  useEffect(() => {
    refresh().catch((e) => notify(humanizeError(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Живое обновление статусов (запуск/прогресс/завершение загрузок).
  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryVersion]);

  async function handlePlay(row: HistoryRow) {
    const v = await findVideoByUrl(row.url);
    if (v) onPlay(v);
    else notify(t("hist.notFoundLibrary"), "error");
  }

  async function handleReveal(row: HistoryRow) {
    const v = await findVideoByUrl(row.url);
    if (v) await revealInExplorer(v.file_path);
    else notify(t("hist.notFound"), "error");
  }

  async function handleClear() {
    await clearHistory();
    await refresh();
    notify(t("hist.cleared"));
  }

  async function handleDelete(row: HistoryRow) {
    await deleteHistoryRow(row.id);
    await refresh();
    notify(t("hist.rowDeleted"));
  }

  // Продолжить (resume) или начать заново (restart) прерванную загрузку.
  async function handleRecover(row: HistoryRow, recovery: "resume" | "restart") {
    const isPlaylist = row.mode === "all" || row.mode === "range";
    await start({
      url: row.url,
      format: row.format ?? "bestvideo+bestaudio/best",
      isAudio: !!row.is_audio,
      audioFormat: row.audio_format,
      mode: (row.mode as "single" | "all" | "range") ?? "single",
      items: row.items,
      meta: {
        // У плейлистов заголовок в БД хранится с префиксом «Плейлист:/Playlist:/播放列表：» —
        // убираем его (любой язык) для чистого meta.title.
        title: isPlaylist
          ? (row.title ?? t("ctx.downloadFallback")).replace(/^[^:：]+[:：]\s*/, "")
          : row.title ?? t("ctx.downloadFallback"),
        platform: row.platform,
        webpage_url: row.url,
        isPlaylist,
      },
      outDir: row.out_dir,
      historyId: row.id,
      recovery,
    });
    await refresh();
    notify(recovery === "resume" ? t("hist.resuming") : t("hist.redownloading"));
  }

  return (
    <div className="mestia-fade-in flex-1 p-12">
      <div className="mx-auto max-w-[1000px] space-y-8">
        <div className="flex items-end justify-between border-b-2 border-fog pb-4">
          <h1 className="text-2xl font-normal tracking-tight">{t("hist.title")}</h1>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 text-sm font-semibold text-smoke hover:text-ink"
          >
            <Trash2 className="h-4 w-4" strokeWidth={2.25} />
            {t("hist.clear")}
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-fog bg-paper/40 text-smoke">
              <ArrowDownToLine className="h-6 w-6" strokeWidth={2} />
            </div>
            <p className="max-w-[280px] text-sm font-semibold text-smoke">{t("hist.empty")}</p>
            <button
              onClick={onGoToDownloader}
              className="mt-1 flex items-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
            >
              <ArrowDownToLine className="h-4 w-4" strokeWidth={2.25} />
              {t("hist.emptyCta")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <HistoryItem
                key={row.id}
                row={row}
                onPlay={() => handlePlay(row)}
                onReveal={() => handleReveal(row)}
                onDelete={() => handleDelete(row)}
                onResume={() => handleRecover(row, "resume")}
                onRestart={() => handleRecover(row, "restart")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryItem({
  row,
  onPlay,
  onReveal,
  onDelete,
  onResume,
  onRestart,
}: {
  row: HistoryRow;
  onPlay: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onResume: () => void;
  onRestart: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "zh" ? "zh-CN" : lang === "en" ? "en-US" : "ru-RU";
  const date = new Date(row.timestamp + "Z").toLocaleString(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={`flex items-center justify-between rounded-ui border-2 border-fog bg-paper/30 p-4 ${
        row.status === "error" ? "opacity-70" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <StatusBadge status={row.status} />
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold tracking-tight">
            {row.title ?? row.url}
          </h4>
          <p className="text-xs font-semibold text-smoke">
            {row.status === "interrupted" ? `${t("hist.interrupted")} · ` : ""}
            {date} · {formatBytes(row.file_size)} · {row.platform ?? "—"}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {row.status === "success" && (
          <>
            <button
              onClick={onReveal}
              title={t("hist.openFolder")}
              className="rounded-ui p-2 text-smoke hover:bg-fog hover:text-ink"
            >
              <FolderOpen className="h-5 w-5" strokeWidth={2.25} />
            </button>
            <button
              onClick={onPlay}
              title={t("hist.play")}
              className="rounded-ui p-2 text-accent hover:bg-fog"
            >
              <PlayCircle className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </>
        )}
        {(row.status === "interrupted" || row.status === "error") && (
          <>
            <button
              onClick={onResume}
              title={t("hist.resume")}
              className="flex items-center gap-1.5 rounded-ui border-2 border-ink px-3 py-1.5 text-xs font-semibold hover:bg-fog"
            >
              <ArrowDownToLine className="h-4 w-4" strokeWidth={2.25} />
              {t("hist.resumeShort")}
            </button>
            <button
              onClick={onRestart}
              title={t("hist.restart")}
              className="rounded-ui p-2 text-smoke hover:bg-fog hover:text-ink"
            >
              <RotateCcw className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </>
        )}
        <button
          onClick={onDelete}
          title={t("hist.deleteRow")}
          className="rounded-ui p-2 text-smoke hover:bg-rose-100 hover:text-rose-600"
        >
          <X className="h-5 w-5" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: HistoryRow["status"] }) {
  if (status === "success") {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
        <Check className="h-5 w-5" strokeWidth={2.25} />
      </div>
    );
  }
  if (status === "downloading") {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-accent">
        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.25} />
      </div>
    );
  }
  if (status === "interrupted") {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
        <PauseCircle className="h-5 w-5" strokeWidth={2.25} />
      </div>
    );
  }
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-500/10 text-rose-500">
      <AlertCircle className="h-5 w-5" strokeWidth={2.25} />
    </div>
  );
}
