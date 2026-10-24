import { useEffect, useMemo, useState } from "react";
import { HardDrive, Search, Send, X } from "lucide-react";
import Modal from "./Modal";
import { useI18n } from "../context/LanguageContext";
import { allVideos } from "../lib/db";
import { formatBytes, getStorageRoot, scanDirs, scanMedia } from "../lib/ipc";
import type { VideoRow } from "../types";

/**
 * Файлы для выбора: записи медиатеки + файлы папки загрузок, ещё не попавшие в БД
 * (Медиатека индексирует диск только при открытии — без этого список мог быть пуст).
 */
async function pickable(): Promise<VideoRow[]> {
  const rows = await allVideos().catch(() => [] as VideoRow[]);
  const known = new Set(rows.map((r) => r.file_path));
  const extra: VideoRow[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const f of await scanMedia(dir).catch(() => [])) {
      if (known.has(f.path)) continue;
      extra.push({
        id: -1 - extra.length,
        title: f.name,
        url: null,
        file_path: f.path,
        duration: null,
        size: f.size,
        folder_id: null,
        thumbnail_path: null,
        platform: null,
        created_at: "",
      });
    }
    if (depth > 0) for (const d of await scanDirs(dir).catch(() => [])) await walk(d.path, depth - 1);
  };
  const root = await getStorageRoot().catch(() => "");
  if (root) await walk(root, 3);
  return [...rows, ...extra];
}

/** Выбор файлов из медиатеки (несколько — для отправки, один — для комнаты). */
export default function LibraryPicker({
  open,
  multi,
  title,
  hint,
  action,
  onDisk,
  onClose,
  onPick,
}: {
  open: boolean;
  multi: boolean;
  title: string;
  hint: string;
  /** Подпись кнопки подтверждения при множественном выборе. */
  action?: (n: number) => string;
  /** Компьютер: выбрать файлы через системный диалог вместо медиатеки. */
  onDisk?: () => void;
  onClose: () => void;
  onPick: (v: VideoRow[]) => void;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState<VideoRow[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(new Set());
    pickable().then(setAll).catch(() => setAll([]));
  }, [open]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? all.filter((v) => v.title.toLowerCase().includes(s)) : all;
  }, [all, q]);

  function click(v: VideoRow) {
    if (!multi) return onPick([v]);
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(v.id)) n.delete(v.id);
      else n.add(v.id);
      return n;
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      cardClassName="mestia-anim flex max-h-[85vh] w-full max-w-[520px] flex-col gap-4 rounded-ui border-2 border-ink bg-snow p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold tracking-tight">{title}</h3>
        <button onClick={onClose} className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink">
          <X className="h-5 w-5" strokeWidth={2.25} />
        </button>
      </div>
      <p className="-mt-2 text-xs font-semibold text-smoke">{hint}</p>
      <div className="flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-2 focus-within:border-accent">
        <Search className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("lan.searchLibrary")}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-ink placeholder-smoke outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {list.length === 0 && <p className="py-8 text-center text-sm font-semibold text-smoke">{t("lan.libraryEmpty")}</p>}
        {list.map((v) => {
          const on = sel.has(v.id);
          return (
            <button
              key={v.id}
              onClick={() => click(v)}
              className={`flex w-full items-center gap-3 rounded-ui border-2 px-3 py-2 text-left text-sm font-semibold ${
                on ? "border-accent bg-paper/40" : "border-transparent hover:bg-fog"
              }`}
            >
              {multi && (
                <input type="checkbox" readOnly checked={on} className="h-4 w-4 shrink-0 accent-accent" />
              )}
              <span className="min-w-0 flex-1 truncate">{v.title}</span>
              <span className="shrink-0 text-xs text-smoke">{formatBytes(v.size)}</span>
            </button>
          );
        })}
      </div>
      {multi && (
        <div className={`flex gap-2 ${onDisk ? "justify-between" : "justify-end"}`}>
          {onDisk && (
            <button
              onClick={onDisk}
              className="flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog"
            >
              <HardDrive className="h-4 w-4" strokeWidth={2.25} />
              {t("lan.fromComputer")}
            </button>
          )}
          <button
            onClick={() => onPick(all.filter((v) => sel.has(v.id)))}
            disabled={sel.size === 0}
            className="flex items-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" strokeWidth={2.25} />
            {action ? action(sel.size) : t("lan.sendN", { n: sel.size })}
          </button>
        </div>
      )}
    </Modal>
  );
}
