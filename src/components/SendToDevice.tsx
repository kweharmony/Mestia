import { Loader2, Monitor, Radar, Send, Smartphone, X } from "lucide-react";
import Modal from "./Modal";
import { useLan } from "../context/LanContext";
import { useI18n } from "../context/LanguageContext";
import { formatBytes } from "../lib/ipc";

/** Выбор устройства рядом, куда отправить выделенные файлы (из Медиатеки). */
export default function SendToDevice({
  files,
  onClose,
  onSent,
}: {
  /** null — окно закрыто. */
  files: { file_path: string; size: number | null }[] | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useI18n();
  const { info, peers, setVisible, sendFiles, sending } = useLan();
  const total = (files ?? []).reduce((n, f) => n + (f.size ?? 0), 0);

  return (
    <Modal
      open={!!files}
      onClose={onClose}
      cardClassName="mestia-anim flex max-h-[80vh] w-full max-w-[420px] flex-col gap-4 rounded-ui border-2 border-ink bg-snow p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight">{t("lan.sendToTitle")}</h3>
          <p className="text-xs font-semibold text-smoke">
            {t("lan.sendToSummary", { n: files?.length ?? 0, size: formatBytes(total) })}
          </p>
        </div>
        <button onClick={onClose} className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink">
          <X className="h-5 w-5" strokeWidth={2.25} />
        </button>
      </div>

      {!info?.running ? (
        <div className="space-y-3 text-center">
          <p className="text-sm font-semibold text-smoke">{t("lan.sendToOff")}</p>
          <button
            onClick={() => setVisible(true)}
            className="inline-flex items-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Radar className="h-4 w-4" strokeWidth={2.25} />
            {t("lan.turnOn")}
          </button>
        </div>
      ) : peers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-accent" strokeWidth={2.25} />
          <p className="text-sm font-semibold">{t("lan.searchingTitle")}</p>
          <p className="text-xs font-semibold text-smoke">{t("lan.searchingText")}</p>
        </div>
      ) : (
        <div className="min-h-0 space-y-2 overflow-y-auto">
          {peers.map((p) => {
            const Icon = p.platform === "android" ? Smartphone : Monitor;
            const busy = sending.has(p.id);
            return (
              <button
                key={p.id}
                disabled={busy || !files?.length}
                onClick={() => {
                  if (!files) return;
                  void sendFiles(p, files.map((f) => f.file_path));
                  onSent();
                }}
                className="flex w-full items-center gap-3 rounded-ui border-2 border-fog p-3 text-left hover:border-accent disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <Icon className="h-4 w-4" strokeWidth={2.25} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-smoke" strokeWidth={2.25} />
                ) : (
                  <Send className="h-4 w-4 text-smoke" strokeWidth={2.25} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
