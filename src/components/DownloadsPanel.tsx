import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowDownToLine,
  Ban,
  Check,
  Clock,
  Cookie,
  Loader2,
  RefreshCw,
  RotateCw,
  Settings2,
  X,
} from "lucide-react";
import { useDownloads, type ActiveDownload } from "../context/DownloadsContext";
import { humanizeError, updateYtdlp } from "../lib/ipc";
import { useI18n } from "../context/LanguageContext";
import { useToast } from "./Toast";

/**
 * Прогресс для полосы и подписи. Для плейлиста — агрегат по всем роликам
 * (готовые + доля текущего), а не сбрасывающийся процент одного файла.
 */
export function overallPercent(d: ActiveDownload): number {
  if (d.isPlaylist && d.totalItems && d.totalItems > 0) {
    const completed = d.index ? d.index - 1 : d.doneCount;
    return Math.min(100, ((completed + d.percent / 100) / d.totalItems) * 100);
  }
  return d.percent;
}

export default function DownloadsPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { downloads, cancel, dismiss, retry } = useDownloads();
  const { t } = useI18n();
  // hovering — для мыши; pinned — для тача/контроллера Steam Deck (клик по кружку).
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovering || pinned;
  if (downloads.length === 0) return null;

  const activeCount = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;
  const spinning = activeCount > 0;

  return (
    <div
      className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2 no-select"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Список загрузок — по наведению (мышь) или по клику/тапу (Steam Deck) */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="mestia-anim w-[330px] space-y-2 rounded-ui border-2 border-ink bg-snow p-3 shadow-lg"
          >
            <div className="flex items-center gap-2 px-1 pb-1 text-xs font-bold uppercase tracking-wider text-smoke">
              <ArrowDownToLine className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} />
              {t("dp.downloads")}
            </div>
            <div className="max-h-[40vh] space-y-2 overflow-y-auto">
              {downloads.map((d) => (
                <div key={d.id} className="rounded-ui border-2 border-fog bg-paper/40 p-2.5">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 shrink-0">
                      <StatusIcon status={d.status} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold">{d.title}</div>
                      <StatusLine d={d} />
                      {d.status === "error" && (
                        <ErrorCta d={d} onOpenSettings={onOpenSettings} onRetry={() => retry(d.id)} />
                      )}
                    </div>
                    {d.status === "downloading" || d.status === "queued" ? (
                      <button
                        onClick={() => cancel(d.id)}
                        className="shrink-0 rounded-ui p-1 text-smoke hover:bg-rose-100 hover:text-rose-600"
                        title={t("dp.cancelTitle")}
                      >
                        <Ban className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                    ) : (
                      <button
                        onClick={() => dismiss(d.id)}
                        className="shrink-0 rounded-ui p-1 text-smoke hover:bg-fog hover:text-ink"
                        title={t("dp.dismiss")}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                  {d.status === "downloading" && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fog">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${overallPercent(d)}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Кружок с крутящейся иконкой — пока есть активные загрузки */}
      <button
        onClick={() => setPinned((p) => !p)}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-ink bg-snow shadow-lg transition-transform hover:scale-105"
        title={t("dp.downloads")}
        aria-label={t("dp.downloads")}
        aria-expanded={open}
      >
        <RefreshCw
          className={`h-[18px] w-[18px] text-accent ${spinning ? "animate-spin motion-reduce:animate-none" : ""}`}
          strokeWidth={2.5}
        />
        {activeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-snow bg-accent px-1 text-[9px] font-bold text-white">
            {activeCount}
          </span>
        )}
      </button>
    </div>
  );
}

function StatusIcon({ status }: { status: ActiveDownload["status"] }) {
  switch (status) {
    case "downloading":
      return <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2.5} />;
    case "queued":
      return <Clock className="h-4 w-4 text-smoke" strokeWidth={2.5} />;
    case "done":
      return <Check className="h-4 w-4 text-emerald-600" strokeWidth={2.75} />;
    case "cancelled":
      return <Ban className="h-4 w-4 text-amber-600" strokeWidth={2.5} />;
    default:
      return <AlertCircle className="h-4 w-4 text-rose-500" strokeWidth={2.5} />;
  }
}

function StatusLine({ d }: { d: ActiveDownload }) {
  const { t } = useI18n();
  if (d.status === "downloading") {
    return (
      <div className="text-[11px] font-semibold text-smoke">
        {d.isPlaylist && d.totalItems
          ? `${t("dp.videoOf", { index: d.index ?? "?", total: d.totalItems })} · ${overallPercent(d).toFixed(0)}%`
          : `${d.percent.toFixed(0)}%`}
      </div>
    );
  }
  if (d.status === "queued") {
    return <div className="text-[11px] font-semibold text-smoke">{t("dp.queued")}</div>;
  }
  if (d.status === "done") {
    return (
      <div className="text-[11px] font-semibold text-emerald-600">
        {d.isPlaylist ? t("dp.downloaded", { count: d.doneCount }) : t("dp.done")}
      </div>
    );
  }
  if (d.status === "cancelled") {
    return <div className="text-[11px] font-semibold text-amber-600">{t("dp.cancelled")}</div>;
  }
  return (
    <div className="truncate text-[11px] font-semibold text-rose-500">
      {d.error ? humanizeError(d.error) : t("dp.error")}
    </div>
  );
}

/**
 * Кнопка-действие под ошибкой: ведёт к решению в зависимости от типа провала.
 * Для DRM и удалённого контента действий нет — кнопку не показываем.
 */
function ErrorCta({
  d,
  onOpenSettings,
  onRetry,
}: {
  d: ActiveDownload;
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  const { notify } = useToast();
  const { t } = useI18n();
  const [updating, setUpdating] = useState(false);

  const base =
    "mt-1.5 inline-flex items-center gap-1 rounded-ui border-2 border-fog px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-accent hover:text-accent";

  async function handleUpdate() {
    setUpdating(true);
    try {
      const msg = await updateYtdlp();
      notify(msg || t("dp.updated"));
    } catch (e) {
      notify(humanizeError(e), "error");
    } finally {
      setUpdating(false);
    }
  }

  switch (d.kind) {
    case "auth":
      return (
        <button onClick={onOpenSettings} className={base}>
          <Cookie className="h-3 w-3" strokeWidth={2.5} /> {t("dp.cta.cookies")}
        </button>
      );
    case "geo":
      return (
        <button onClick={onOpenSettings} className={base}>
          <Settings2 className="h-3 w-3" strokeWidth={2.5} /> {t("dp.cta.proxy")}
        </button>
      );
    case "unsupported":
      return (
        <button onClick={handleUpdate} disabled={updating} className={base}>
          {updating ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
          ) : (
            <RefreshCw className="h-3 w-3" strokeWidth={2.5} />
          )}
          {t("dp.cta.update")}
        </button>
      );
    case "network":
      return (
        <button onClick={onRetry} className={base}>
          <RotateCw className="h-3 w-3" strokeWidth={2.5} /> {t("dp.cta.retry")}
        </button>
      );
    // drm / unavailable / unknown — действий нет.
    default:
      return null;
  }
}
