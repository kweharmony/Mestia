import { useEffect, useMemo, useState } from "react";
import { ArrowDownUp, Film, HardDrive, Loader2, Music, Search, Send, X } from "lucide-react";
import Modal from "./Modal";
import { useI18n } from "../context/LanguageContext";
import { allVideos } from "../lib/db";
import { formatBytes, formatDuration, getStorageRoot, isAudioPath, scanDirs, scanMedia } from "../lib/ipc";
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

type Kind = "all" | "video" | "audio";
/** Больше строк сразу не рисуем — на тысячах файлов окно иначе тормозит. */
const LIMIT = 300;
/** Значение «все папки» в выпадающем списке (имя папки таким быть не может). */
const ALL_FOLDERS = "\u0000";

/** Папка файла относительно корня хранилища ("" — лежит в корне). */
function folderOf(path: string, root: string): string {
  const norm = (x: string) => x.replace(/\\/g, "/");
  const p = norm(path);
  const r = norm(root).replace(/\/+$/, "");
  const rel = r && p.startsWith(r + "/") ? p.slice(r.length + 1) : p;
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/**
 * Выбор файлов из медиатеки (несколько — для отправки и очереди, один — для комнаты).
 * Для больших медиатек: поиск, фильтр видео/музыка, папки, сортировка, «выбрать все».
 */
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
  const [root, setRoot] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [folder, setFolder] = useState<string>(ALL_FOLDERS);
  const [sort, setSort] = useState<"new" | "name">("new");
  const [sel, setSel] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(new Set());
    setLoading(true);
    Promise.all([pickable(), getStorageRoot().catch(() => "")])
      .then(([rows, r]) => {
        setAll(rows);
        setRoot(r);
      })
      .catch(() => setAll([]))
      .finally(() => setLoading(false));
  }, [open]);

  const counts = useMemo(() => {
    const audio = all.filter((v) => isAudioPath(v.file_path)).length;
    return { all: all.length, audio, video: all.length - audio };
  }, [all]);

  const folders = useMemo(() => {
    const set = new Set(all.map((v) => folderOf(v.file_path, root)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [all, root]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = all.filter(
      (v) =>
        (kind === "all" || (kind === "audio") === isAudioPath(v.file_path)) &&
        (folder === ALL_FOLDERS || folderOf(v.file_path, root) === folder) &&
        (!s || v.title.toLowerCase().includes(s))
    );
    if (sort === "name") out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, [all, root, q, kind, folder, sort]);

  const allShownSelected = list.length > 0 && list.every((v) => sel.has(v.id));
  const selSize = all.filter((v) => sel.has(v.id)).reduce((n, v) => n + (v.size ?? 0), 0);

  function click(v: VideoRow) {
    if (!multi) return onPick([v]);
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(v.id)) n.delete(v.id);
      else n.add(v.id);
      return n;
    });
  }

  function toggleAllShown() {
    setSel((prev) => {
      const n = new Set(prev);
      for (const v of list) {
        if (allShownSelected) n.delete(v.id);
        else n.add(v.id);
      }
      return n;
    });
  }

  const chip = (on: boolean) =>
    `shrink-0 rounded-full border-2 px-3 py-1 text-xs font-semibold ${
      on ? "border-accent text-accent" : "border-fog text-smoke hover:bg-fog hover:text-ink"
    }`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      cardClassName="mestia-anim flex max-h-[92vh] w-full max-w-[560px] flex-col gap-3 rounded-ui border-2 border-ink bg-snow p-4 sm:p-5 [@media(max-height:520px)]:gap-2 [@media(max-height:520px)]:p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold tracking-tight">{title}</h3>
        <button onClick={onClose} className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink">
          <X className="h-5 w-5" strokeWidth={2.25} />
        </button>
      </div>
      <p className="-mt-2 text-xs font-semibold text-smoke [@media(max-height:520px)]:hidden">{hint}</p>

      <div className="flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-2 focus-within:border-accent">
        <Search className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("lan.searchLibrary")}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-ink placeholder-smoke outline-none"
        />
        {q && (
          <button onClick={() => setQ("")} className="text-smoke hover:text-ink">
            <X className="h-4 w-4" strokeWidth={2.25} />
          </button>
        )}
      </div>

      {/* Фильтры: тип, папка, сортировка */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "video", "audio"] as Kind[]).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={chip(kind === k)}>
            {k === "all" ? t("pick.all") : k === "video" ? t("pick.video") : t("pick.audio")} {counts[k]}
          </button>
        ))}
        {folders.length > 1 && (
          <select
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            className="min-w-0 max-w-[45%] rounded-full border-2 border-fog bg-snow px-2 py-1 text-xs font-semibold text-ink outline-none focus:border-accent"
          >
            <option value={ALL_FOLDERS}>{t("pick.allFolders")}</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f || t("pick.rootFolder")}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => setSort((s) => (s === "new" ? "name" : "new"))}
          className="ml-auto flex shrink-0 items-center gap-1 text-xs font-semibold text-smoke hover:text-ink"
        >
          <ArrowDownUp className="h-3.5 w-3.5" strokeWidth={2.25} />
          {sort === "new" ? t("pick.sortNew") : t("pick.sortName")}
        </button>
      </div>

      {multi && list.length > 0 && (
        <button
          onClick={toggleAllShown}
          className="flex items-center gap-2 self-start text-xs font-semibold text-accent hover:opacity-80"
        >
          <input type="checkbox" readOnly checked={allShownSelected} className="h-4 w-4 accent-accent" />
          {allShownSelected ? t("pick.unselectShown", { n: list.length }) : t("pick.selectShown", { n: list.length })}
        </button>
      )}

      <div className="min-h-[120px] flex-1 space-y-1 overflow-y-auto">
        {loading && all.length === 0 && (
          <p className="flex items-center justify-center py-8 text-smoke">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.25} />
          </p>
        )}
        {!loading && list.length === 0 && (
          <p className="py-8 text-center text-sm font-semibold text-smoke">
            {all.length ? t("pick.nothingFound") : t("lan.libraryEmpty")}
          </p>
        )}
        {list.slice(0, LIMIT).map((v) => {
          const on = sel.has(v.id);
          const audio = isAudioPath(v.file_path);
          const dir = folderOf(v.file_path, root);
          const meta = [dir, v.duration ? formatDuration(v.duration) : "", formatBytes(v.size)].filter(Boolean).join(" · ");
          return (
            <button
              key={v.id}
              onClick={() => click(v)}
              className={`flex w-full items-center gap-3 rounded-ui border-2 px-3 py-2 text-left text-sm font-semibold ${
                on ? "border-accent bg-paper/40" : "border-transparent hover:bg-fog"
              }`}
            >
              {multi && <input type="checkbox" readOnly checked={on} className="h-4 w-4 shrink-0 accent-accent" />}
              {audio ? (
                <Music className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
              ) : (
                <Film className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{v.title}</span>
                <span className="block truncate text-[11px] text-smoke">{meta}</span>
              </span>
            </button>
          );
        })}
        {list.length > LIMIT && (
          <p className="py-2 text-center text-xs font-semibold text-smoke">
            {t("pick.limited", { n: LIMIT, total: list.length })}
          </p>
        )}
      </div>

      {multi && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-fog pt-3">
          <span className="text-xs font-semibold text-smoke">
            {sel.size ? t("pick.selected", { n: sel.size, size: formatBytes(selSize) }) : t("pick.noneSelected")}
          </span>
          <div className="flex gap-2">
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
        </div>
      )}
    </Modal>
  );
}
