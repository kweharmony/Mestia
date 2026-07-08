import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Music,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Check,
  X,
} from "lucide-react";
import {
  allFolderPaths,
  allVideoPaths,
  createFolder,
  deleteFolderTree,
  deleteVideoRow,
  insertVideo,
  listFolders,
  listVideos,
  moveVideoToFolder,
  pruneOutsideRoot,
  reassignVideosToFolder,
  renameFolderRows,
  renameVideo,
  searchVideos,
  updateVideoPath,
  updateVideoThumb,
  videosBySize,
} from "../lib/db";
import {
  createFolderOnDisk,
  deleteFileOnDisk,
  deleteFolderOnDisk,
  existingPaths,
  formatBytes,
  formatDuration,
  generateThumbnail,
  getStorageRoot,
  humanizeError,
  isAudioPath,
  moveVideoFile,
  onLibraryChanged,
  openFolder,
  renameFolderOnDisk,
  scanDirs,
  scanMedia,
  watchLibrary,
} from "../lib/ipc";
import type { FolderRow, VideoRow } from "../types";
import { useDrag } from "../context/DragContext";
import { useDownloads } from "../context/DownloadsContext";
import { useToast } from "../components/Toast";
import { useI18n } from "../context/LanguageContext";
import Typewriter from "../components/Typewriter";

const SEARCH_HINT_KEYS = ["lib.sh.0", "lib.sh.1", "lib.sh.2", "lib.sh.3", "lib.sh.4", "lib.sh.5"];

// Отсрочка перед удалением записи о пропавшем файле — чтобы переезд файла
// (проводником) не стёр его метаданные до усыновления в папке-назначении.
const MISSING_GRACE_MS = 60_000;

// Нормализация пути для сравнения (без хвостового слэша, в нижнем регистре).
function normPath(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}
// Родительский каталог пути.
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

type Renaming = { kind: "folder" | "video"; id: number } | null;
type Confirm = { text: string; action: () => Promise<void> } | null;
type DropTarget = { id: number | null; path: string; name: string };

export default function Locker({
  onPlay,
}: {
  onPlay: (v: VideoRow, queue?: VideoRow[]) => void;
}) {
  const { dragging, startDrag, endDrag } = useDrag();
  const { libraryVersion } = useDownloads();
  const { notify } = useToast();
  const { t } = useI18n();

  const [storageRoot, setStorageRoot] = useState("");
  const [trail, setTrail] = useState<FolderRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [hoverFolderId, setHoverFolderId] = useState<number | null>(null);
  const [hoverCrumb, setHoverCrumb] = useState<number | "root" | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set());

  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [results, setResults] = useState<VideoRow[]>([]);
  const searchActive = query.trim().length > 0;

  // Сортировка и фильтр по типу медиа (применяются к показанным видео).
  const [sortKey, setSortKey] = useState<"date" | "name" | "size">("date");
  const [kindFilter, setKindFilter] = useState<"all" | "video" | "audio">("all");

  const [renaming, setRenaming] = useState<Renaming>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);

  // Множественный выбор видео.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const selectionMode = selected.size > 0;

  const current = trail.length ? trail[trail.length - 1] : null;
  const currentId = current?.id ?? null;
  const currentPath = current?.path ?? storageRoot;
  const displayed = searchActive ? results : videos;

  // Показанные видео с учётом фильтра по типу и сортировки.
  const shownVideos = useMemo(() => {
    let arr = displayed;
    if (kindFilter !== "all") {
      const wantAudio = kindFilter === "audio";
      arr = arr.filter((v) => isAudioPath(v.file_path) === wantAudio);
    }
    if (sortKey === "date") return arr; // из БД/поиска уже по дате (новые сверху)
    const sorted = [...arr];
    if (sortKey === "name") sorted.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    else sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)); // size: крупные сверху
    return sorted;
  }, [displayed, kindFilter, sortKey]);

  // ── Фоновая генерация обложек для видео без превью ───────────────────────────
  const thumbAttempts = useRef<Set<number>>(new Set());
  // id видео, для которых сейчас генерится кадр — показываем скелетон.
  const [generatingIds, setGeneratingIds] = useState<Set<number>>(new Set());
  const markGen = (id: number, on: boolean) =>
    setGeneratingIds((s) => {
      const n = new Set(s);
      on ? n.add(id) : n.delete(id);
      return n;
    });
  useEffect(() => {
    let cancelled = false;
    const targets = videos.filter(
      (v) => !v.thumbnail_path && !isAudioPath(v.file_path) && !thumbAttempts.current.has(v.id)
    );
    if (!targets.length) return;
    const queue = [...targets];
    // Пул воркеров: обложки генерятся параллельно (по несколько сразу), а не по одной.
    const worker = async () => {
      for (let v = queue.shift(); v && !cancelled; v = queue.shift()) {
        thumbAttempts.current.add(v.id);
        markGen(v.id, true);
        try {
          const thumb = await generateThumbnail(v.file_path);
          if (cancelled) return;
          await updateVideoThumb(v.id, thumb);
          setVideos((cur) =>
            cur.map((x) => (x.id === v!.id ? { ...x, thumbnail_path: thumb } : x))
          );
        } catch {
          /* нет кадра — оставляем заглушку */
        } finally {
          markGen(v.id, false);
        }
      }
    };
    const POOL = 3;
    void Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
    return () => {
      cancelled = true;
    };
  }, [videos]);

  // ── Выделение рамкой (как в проводнике) ──────────────────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const selecting = useRef(false);
  const startPt = useRef({ x: 0, y: 0 });
  const baseSel = useRef<Set<number>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  );

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!selecting.current) return;
      const x1 = Math.min(startPt.current.x, e.clientX);
      const y1 = Math.min(startPt.current.y, e.clientY);
      const x2 = Math.max(startPt.current.x, e.clientX);
      const y2 = Math.max(startPt.current.y, e.clientY);
      setMarquee({ x1, y1, x2, y2 });
      const grid = gridRef.current;
      if (!grid) return;
      const next = new Set(baseSel.current);
      grid.querySelectorAll<HTMLElement>("[data-video-id]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2)) {
          next.add(Number(el.dataset.videoId));
        }
      });
      setSelected(next);
    }
    function onUp() {
      if (!selecting.current) return;
      selecting.current = false;
      setMarquee(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function onGridMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    // Рамку начинаем только на пустом месте (не на карточке/кнопке/поле).
    if (t.closest("[data-card]") || t.closest("button") || t.closest("input")) return;
    e.preventDefault();
    selecting.current = true;
    startPt.current = { x: e.clientX, y: e.clientY };
    baseSel.current = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(selected) : new Set();
    setSelected(baseSel.current);
    setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
  }

  // Сериализация reload(): параллельные вызовы (фокус + watcher + смена папки)
  // не должны пересекаться и делать insert/delete одновременно.
  const reloadingRef = useRef(false);
  const reloadAgainRef = useRef(false);
  // Корень, для которого уже сделан prune — чтобы не гонять полный перебор БД
  // на каждый фокус/обновление, а только при реальной смене корня хранилища.
  const prunedRootRef = useRef<string | null>(null);
  // id видео → когда его файл впервые заметили пропавшим (для отсрочки удаления).
  const missingSinceRef = useRef<Map<number, number>>(new Map());

  async function reload() {
    if (reloadingRef.current) {
      reloadAgainRef.current = true; // перезапустим один раз после текущего прохода
      return;
    }
    reloadingRef.current = true;
    try {
      await doReload();
    } finally {
      reloadingRef.current = false;
      if (reloadAgainRef.current) {
        reloadAgainRef.current = false;
        void reload();
      }
    }
  }

  // Возможно, файл переехал в эту папку извне (проводником): вместо вставки нового
  // «Локального файла» усыновляем существующую запись того же размера, чей файл
  // пропал по старому пути — так сохраняются название, обложка и платформа.
  async function adoptMoved(
    f: { path: string; name: string; size: number },
    folderId: number | null
  ): Promise<boolean> {
    if (!f.size) return false;
    const cands = await videosBySize(f.size);
    if (!cands.length) return false;
    const present = await existingPaths(cands.map((c) => c.file_path));
    const gone = cands.filter((c, i) => !present[i] && c.file_path !== f.path);
    if (!gone.length) return false;
    const stem = (p: string) =>
      (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "").toLowerCase();
    const target = gone.find((c) => stem(c.file_path) === f.name.toLowerCase()) ?? gone[0];
    await updateVideoPath(target.id, f.path, folderId);
    return true;
  }

  async function doReload() {
    // Чистим записи от прежнего корня хранилища только при смене корня (не каждый раз).
    if (storageRoot && prunedRootRef.current !== storageRoot) {
      await pruneOutsideRoot(storageRoot).catch(() => {});
      prunedRootRef.current = storageRoot;
    }

    // Подхватываем вручную добавленные на диск подпапки и медиафайлы текущей папки.
    const dir = current?.path ?? storageRoot;
    if (dir) {
      try {
        const subdirs = await scanDirs(dir);
        if (subdirs.length) {
          const knownDirs = await allFolderPaths();
          for (const sd of subdirs) {
            if (!knownDirs.has(sd.path)) await createFolder(sd.name, sd.path, currentId);
          }
        }
        const files = await scanMedia(dir);
        if (files.length) {
          const knownFiles = await allVideoPaths();
          for (const f of files) {
            if (knownFiles.has(f.path)) continue;
            // Сначала пробуем усыновить переехавшую запись (сохранив метаданные).
            if (await adoptMoved(f, currentId)) continue;
            await insertVideo({
              title: f.name,
              url: null,
              file_path: f.path,
              duration: null,
              size: f.size,
              thumbnail_path: null,
              platform: t("lib.localFile"),
              folder_id: currentId,
            });
          }
          // Уже известные файлы, физически лежащие здесь, но привязанные в БД к
          // другой папке, — перепривязываем к текущей (иначе папка «пустая»).
          await reassignVideosToFolder(files.map((f) => f.path), currentId);
        }
      } catch {
        /* ошибки сканирования игнорируем */
      }
    }
    let folders = await listFolders(currentId);
    let vids = await listVideos(currentId);

    // Удаляем из библиотеки то, чего больше нет на диске. Но не сразу: файл мог
    // просто переехать в другую папку (проводником) — даём отсрочку, чтобы он
    // успел быть усыновлён при открытии папки-назначения и не потерял метаданные.
    try {
      const now = Date.now();
      const vEx = await existingPaths(vids.map((v) => v.file_path));
      const seen = missingSinceRef.current;
      const toDelete: VideoRow[] = [];
      vids.forEach((v, i) => {
        if (vEx[i]) {
          seen.delete(v.id); // файл на месте — снимаем метку «пропал»
          return;
        }
        const since = seen.get(v.id);
        if (since === undefined) seen.set(v.id, now); // впервые пропал — ждём
        else if (now - since > MISSING_GRACE_MS) toDelete.push(v);
      });
      await Promise.all(toDelete.map((v) => deleteVideoRow(v.id)));
      toDelete.forEach((v) => seen.delete(v.id));
      // В сетке показываем только реально существующие файлы; пропавшие в отсрочке
      // остаются в БД (ждут усыновления в папке-назначении), но не мозолят глаза.
      vids = vids.filter((_, i) => vEx[i]);
      const fEx = await existingPaths(folders.map((f) => f.path));
      for (const f of folders.filter((_, i) => !fEx[i])) await deleteFolderTree(f.id);
      folders = folders.filter((_, i) => fEx[i]);
    } catch {
      /* проверка существования необязательна */
    }

    // В корне показываем только то, что физически лежит в текущем хранилище —
    // иначе остаются «прилипшие» папки/файлы от прежнего пути.
    if (currentId === null && dir) {
      const root = normPath(dir);
      folders = folders.filter((f) => normPath(parentDir(f.path)) === root);
      vids = vids.filter((v) => normPath(parentDir(v.file_path)) === root);
    }
    setFolders(folders);
    setVideos(vids);
    if (query.trim()) setResults(await searchVideos(query.trim()));
  }

  useEffect(() => {
    getStorageRoot().then(setStorageRoot).catch(() => {});
  }, []);

  useEffect(() => {
    setSelected(new Set()); // сбрасываем выбор при смене папки / появлении корня
    reload().catch((e) => notify(humanizeError(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, storageRoot]);

  // Живое обновление при завершении фоновых загрузок (с дебаунсом).
  useEffect(() => {
    if (libraryVersion === 0) return;
    const t = window.setTimeout(() => {
      reload().catch(() => {});
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryVersion]);

  // Пере-скан при возврате фокуса на окно (подхватывает вручную добавленные файлы).
  useEffect(() => {
    const onFocus = () => reload().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, storageRoot]);

  // Слежение за папкой библиотеки в реальном времени.
  useEffect(() => {
    if (storageRoot) watchLibrary(storageRoot).catch(() => {});
  }, [storageRoot]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    onLibraryChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => reload().catch(() => {}), 700);
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, storageRoot]);

  useEffect(() => {
    setSelected(new Set()); // и при изменении поискового запроса
    if (searchActive) searchVideos(query.trim()).then(setResults).catch(() => {});
    else setResults([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Горячие клавиши медиатеки: Ctrl/Cmd+A — выбрать всё, Delete — удалить выбранное.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || renaming || confirm) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "ф" || e.key === "Ф")) {
        if (shownVideos.length === 0) return;
        e.preventDefault();
        setSelected(new Set(shownVideos.map((v) => v.id)));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        askDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownVideos, selected, renaming, confirm]);

  function enterFolder(folder: FolderRow) {
    // Защита от двойного/быстрого клика: не заталкиваем одну и ту же папку
    // в крошки повторно (иначе путь дублируется: …→ Папка → Папка).
    setTrail((t) => (t.length && t[t.length - 1].id === folder.id ? t : [...t, folder]));
  }
  function goToCrumb(index: number) {
    setTrail((t) => (index < 0 ? [] : t.slice(0, index + 1)));
  }

  function toggleSelect(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Сменить обложку (фон) видео/аудио — выбрать картинку с диска.
  async function handleSetCover(v: VideoRow) {
    try {
      const img = await open({
        multiple: false,
        filters: [{ name: t("lib.imagesFilter"), extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
      });
      if (typeof img !== "string") return;
      await updateVideoThumb(v.id, img);
      setVideos((cur) => cur.map((x) => (x.id === v.id ? { ...x, thumbnail_path: img } : x)));
      if (searchActive) setResults((cur) => cur.map((x) => (x.id === v.id ? { ...x, thumbnail_path: img } : x)));
      notify(t("lib.coverUpdated"));
    } catch (e) {
      notify(humanizeError(e), "error");
    }
  }

  const creatingBusy = useRef(false);
  async function handleCreateFolder() {
    const name = newName.trim();
    if (!name || creatingBusy.current) return; // защита от повторного сабмита
    creatingBusy.current = true;
    try {
      const path = await createFolderOnDisk(name, current?.path ?? null);
      await createFolder(name, path, currentId);
      setNewName("");
      setCreating(false);
      await reload();
      notify(t("lib.folderCreated", { name }));
    } catch (e) {
      notify(humanizeError(e), "error");
    } finally {
      creatingBusy.current = false;
    }
  }

  // Перемещение набора видео в цель (папка или крошка).
  async function moveVideosTo(target: DropTarget, vids: VideoRow[]) {
    endDrag();
    setHoverFolderId(null);
    setHoverCrumb(null);
    const toMove = vids.filter((v) => v.folder_id !== target.id);
    if (toMove.length === 0) return;
    setLeavingIds(new Set(toMove.map((v) => v.id)));
    try {
      for (const v of toMove) {
        const newPath = await moveVideoFile(v.file_path, target.path);
        await moveVideoToFolder(v.id, target.id, newPath);
      }
      window.setTimeout(async () => {
        setLeavingIds(new Set());
        setSelected(new Set());
        await reload();
        notify(
          toMove.length > 1
            ? t("lib.movedMulti", { count: toMove.length, name: target.name })
            : t("lib.movedOne", { name: target.name })
        );
      }, 220);
    } catch (e) {
      setLeavingIds(new Set());
      notify(humanizeError(e), "error");
    }
  }

  // Что перетаскиваем: всю выборку (если тянем выбранную карточку) или одну.
  function dropMove(target: DropTarget) {
    const dragged = dragging;
    if (!dragged) {
      endDrag();
      return;
    }
    const vids =
      selected.has(dragged.id) && selected.size > 0
        ? displayed.filter((v) => selected.has(v.id))
        : [dragged];
    moveVideosTo(target, vids);
  }

  function startRename(kind: "folder" | "video", id: number, value: string) {
    setRenaming({ kind, id });
    setRenameValue(value);
  }

  async function commitRename() {
    if (!renaming) return;
    const val = renameValue.trim();
    if (!val) {
      setRenaming(null);
      return;
    }
    try {
      if (renaming.kind === "folder") {
        const f = folders.find((x) => x.id === renaming.id);
        if (f) {
          const newPath = await renameFolderOnDisk(f.path, val);
          await renameFolderRows(f.id, f.path, newPath, val);
        }
      } else {
        await renameVideo(renaming.id, val);
      }
      setRenaming(null);
      await reload();
      notify(t("lib.renamed"));
    } catch (e) {
      notify(humanizeError(e), "error");
    }
  }

  function askDeleteVideo(v: VideoRow) {
    setConfirm({
      text: t("lib.confirmDeleteVideo", { title: v.title }),
      action: async () => {
        await deleteFileOnDisk(v.file_path);
        await deleteVideoRow(v.id);
        await reload();
        notify(t("lib.videoDeleted"));
      },
    });
  }
  function askDeleteFolder(f: FolderRow) {
    setConfirm({
      text: t("lib.confirmDeleteFolder", { name: f.name }),
      action: async () => {
        await deleteFolderOnDisk(f.path);
        await deleteFolderTree(f.id);
        await reload();
        notify(t("lib.folderDeleted"));
      },
    });
  }
  function askDeleteSelected() {
    const vids = shownVideos.filter((v) => selected.has(v.id));
    if (!vids.length) return;
    setConfirm({
      text: t("lib.confirmDeleteSelected", { count: vids.length }),
      action: async () => {
        for (const v of vids) {
          await deleteFileOnDisk(v.file_path);
          await deleteVideoRow(v.id);
        }
        setSelected(new Set());
        await reload();
        notify(t("lib.deletedCount", { count: vids.length }));
      },
    });
  }

  return (
    <div className="mestia-fade-in flex-1 p-12">
      <div className="mx-auto max-w-[1000px] space-y-6">
        {/* Заголовок: крошки + действия */}
        <div className="flex items-end justify-between gap-4 border-b-2 border-fog pb-4">
          <div className="flex flex-wrap items-center gap-1 text-2xl font-normal tracking-tight">
            <button
              onClick={() => goToCrumb(-1)}
              onDragOver={(e) => {
                e.preventDefault();
                setHoverCrumb("root");
              }}
              onDragLeave={() => setHoverCrumb(null)}
              onDrop={(e) => {
                e.preventDefault();
                dropMove({ id: null, path: storageRoot, name: t("lib.title") });
              }}
              className={`rounded-ui px-1 ${
                hoverCrumb === "root" ? "bg-accent/20 ring-2 ring-accent" : ""
              } ${trail.length ? "text-smoke hover:text-ink" : ""}`}
            >
              {t("lib.title")}
            </button>
            {trail.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1">
                <ChevronRight className="h-5 w-5 text-smoke" strokeWidth={2.25} />
                <button
                  onClick={() => goToCrumb(i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setHoverCrumb(f.id);
                  }}
                  onDragLeave={() => setHoverCrumb(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropMove({ id: f.id, path: f.path, name: f.name });
                  }}
                  className={`rounded-ui px-1 ${
                    hoverCrumb === f.id ? "bg-accent/20 ring-2 ring-accent" : ""
                  } ${i === trail.length - 1 ? "" : "text-smoke hover:text-ink"}`}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => reload().catch((e) => notify(humanizeError(e), "error"))}
              title={t("lib.refresh")}
              className="mestia-nav flex items-center justify-center rounded-ui border-2 border-fog p-2 hover:bg-fog"
            >
              <RefreshCw className="mestia-ico-gear h-4 w-4" strokeWidth={2.25} />
            </button>
            <button
              onClick={() => openFolder(currentPath).catch((e) => notify(humanizeError(e), "error"))}
              title={t("lib.openExplorer")}
              className="mestia-nav flex items-center justify-center rounded-ui border-2 border-ink p-2 hover:bg-fog"
            >
              <FolderOpen className="mestia-ico-open h-4 w-4" strokeWidth={2.25} />
            </button>
            {creating ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                    if (e.key === "Escape") setCreating(false);
                  }}
                  placeholder={t("lib.folderNamePlaceholder")}
                  className="rounded-ui border-2 border-accent bg-snow px-3 py-2 text-sm font-semibold outline-none"
                />
                <button onClick={handleCreateFolder} className="rounded-ui border-2 border-ink p-2 hover:bg-fog">
                  <Check className="h-4 w-4" strokeWidth={2.25} />
                </button>
                <button onClick={() => setCreating(false)} className="rounded-ui border-2 border-fog p-2 hover:bg-fog">
                  <X className="h-4 w-4" strokeWidth={2.25} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="mestia-nav flex items-center gap-2 rounded-ui border-2 border-ink px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                <FolderPlus className="mestia-ico-folderplus h-4 w-4" strokeWidth={2.25} />
                {t("lib.newFolder")}
              </button>
            )}
          </div>
        </div>

        {/* Поиск */}
        <div className="relative flex items-center gap-2 rounded-ui border-2 border-fog bg-snow px-3 focus-within:border-accent">
          <Search className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder=""
            className="flex-1 bg-transparent py-2.5 text-sm font-semibold text-ink outline-none"
          />
          {!query && !searchFocused && (
            <div className="pointer-events-none absolute inset-y-0 left-9 right-9 flex items-center overflow-hidden text-sm font-semibold text-smoke">
              <Typewriter phrases={SEARCH_HINT_KEYS.map((k) => t(k))} className="whitespace-nowrap" />
            </div>
          )}
          {searchActive && (
            <button onClick={() => setQuery("")} className="text-smoke hover:text-ink">
              <X className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
        </div>

        {/* Панель сортировки и фильтра */}
        {(displayed.length > 0 || kindFilter !== "all") && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {([
                ["all", "lib.all"],
                ["video", "lib.video"],
                ["audio", "lib.audio"],
              ] as const).map(([k, labelKey]) => (
                <button
                  key={k}
                  onClick={() => setKindFilter(k)}
                  className={`rounded-ui border-2 px-3 py-1.5 text-xs font-semibold ${
                    kindFilter === k
                      ? "border-accent text-accent"
                      : "border-transparent text-smoke hover:bg-fog"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowDownUp className="h-3.5 w-3.5 text-smoke" strokeWidth={2.25} />
              {([
                ["date", "lib.sortDate"],
                ["name", "lib.sortName"],
                ["size", "lib.sortSize"],
              ] as const).map(([k, labelKey]) => (
                <button
                  key={k}
                  onClick={() => setSortKey(k)}
                  className={`rounded-ui border-2 px-3 py-1.5 text-xs font-semibold ${
                    sortKey === k
                      ? "border-accent text-accent"
                      : "border-transparent text-smoke hover:bg-fog"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Панель выбора */}
        <AnimatePresence>
        {selectionMode && (
          <motion.div
            initial={{ opacity: 0, y: -10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -10, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mestia-anim flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-ui border-2 border-accent bg-accent/10 px-4 py-2.5"
          >
            <span className="text-sm font-semibold">{t("lib.selected", { count: selected.size })}</span>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="hidden text-smoke md:inline">{t("lib.dragHint")}</span>
              <button
                onClick={() => setSelected(new Set(shownVideos.map((v) => v.id)))}
                className="rounded-ui border-2 border-ink px-3 py-1.5 hover:bg-fog"
              >
                {t("lib.selectAll")}
              </button>
              <button
                onClick={askDeleteSelected}
                className="flex items-center gap-1.5 rounded-ui border-2 border-ink bg-rose-600 px-3 py-1.5 text-white hover:opacity-90"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2.25} />
                {t("lib.delete")}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="rounded-ui border-2 border-fog px-3 py-1.5 hover:bg-fog"
              >
                {t("lib.deselect")}
              </button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Контент — с выделением рамкой */}
        <div ref={gridRef} onMouseDown={onGridMouseDown} className="relative min-h-[300px]">
        {searchActive ? (
          results.length === 0 ? (
            <EmptyState icon={Search} text={t("lib.noResults", { query })} />
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              <AnimatePresence mode="popLayout">
              {shownVideos.map((v) => (
                <VideoCard
                  key={`s-${v.id}`}
                  video={v}
                  leaving={leavingIds.has(v.id)}
                  generating={generatingIds.has(v.id)}
                  selected={selected.has(v.id)}
                  selectionMode={selectionMode}
                  onToggleSelect={() => toggleSelect(v.id)}
                  renaming={renaming?.kind === "video" && renaming.id === v.id}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  onCommit={commitRename}
                  onCancel={() => setRenaming(null)}
                  onPlay={() => onPlay(v)}
                  onRename={() => startRename("video", v.id, v.title)}
                  onDelete={() => askDeleteVideo(v)}
                  onCover={() => handleSetCover(v)}
                  draggable
                  onDragStart={() => startDrag(v)}
                  onDragEnd={endDrag}
                />
              ))}
              </AnimatePresence>
            </div>
          )
        ) : folders.length === 0 && videos.length === 0 ? (
          trail.length ? (
            <EmptyState icon={FolderOpen} text={t("lib.emptyFolder")} />
          ) : (
            <EmptyState icon={Download} text={t("lib.emptyRoot")} />
          )
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <AnimatePresence mode="popLayout">
            {folders.map((folder) => (
              <FolderCardView
                key={`f-${folder.id}`}
                folder={folder}
                hover={hoverFolderId === folder.id}
                renaming={renaming?.kind === "folder" && renaming.id === folder.id}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                onCommit={commitRename}
                onCancel={() => setRenaming(null)}
                onEnter={() => enterFolder(folder)}
                onRename={() => startRename("folder", folder.id, folder.name)}
                onDelete={() => askDeleteFolder(folder)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setHoverFolderId(folder.id);
                }}
                onDragLeave={() => setHoverFolderId(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  dropMove({ id: folder.id, path: folder.path, name: folder.name });
                }}
              />
            ))}
            {shownVideos.map((video) => (
              <VideoCard
                key={`v-${video.id}`}
                video={video}
                leaving={leavingIds.has(video.id)}
                generating={generatingIds.has(video.id)}
                selected={selected.has(video.id)}
                selectionMode={selectionMode}
                onToggleSelect={() => toggleSelect(video.id)}
                renaming={renaming?.kind === "video" && renaming.id === video.id}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                onCommit={commitRename}
                onCancel={() => setRenaming(null)}
                onPlay={() => onPlay(video)}
                onRename={() => startRename("video", video.id, video.title)}
                onDelete={() => askDeleteVideo(video)}
                onCover={() => handleSetCover(video)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", String(video.id));
                  e.dataTransfer.effectAllowed = "move";
                  startDrag(video);
                }}
                onDragEnd={endDrag}
              />
            ))}
            </AnimatePresence>
          </div>
        )}
        </div>

        {/* Рамка выделения (цвет — акцент темы) */}
        {marquee &&
          createPortal(
            <div
              className="pointer-events-none fixed z-[60] rounded-[3px] border-2 border-accent bg-accent/20"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />,
            document.body
          )}
      </div>

      {/* Подтверждение удаления */}
      <AnimatePresence>
      {confirm && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="mestia-anim fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
          onClick={() => setConfirm(null)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="mestia-anim w-full max-w-[380px] space-y-5 rounded-ui border-2 border-ink bg-snow p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold leading-snug">{confirm.text}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={async () => {
                  const act = confirm.action;
                  setConfirm(null);
                  try {
                    await act();
                  } catch (e) {
                    notify(humanizeError(e), "error");
                  }
                }}
                className="flex items-center gap-2 rounded-ui border-2 border-ink bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2.25} />
                {t("lib.delete")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

// ── Карточка папки ─────────────────────────────────────────────────────────────
function FolderCardView(props: {
  folder: FolderRow;
  hover: boolean;
  renaming: boolean;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onEnter: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { folder, hover, renaming } = props;
  const { t } = useI18n();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: hover ? 1.03 : 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      data-card
      onClick={() => !renaming && props.onEnter()}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      className={`mestia-anim group relative cursor-pointer rounded-ui border-2 p-2.5 no-select ${
        hover
          ? "border-accent bg-accent/5"
          : "border-transparent hover:border-fog hover:bg-paper/40"
      }`}
    >
      {/* Действия — на тач-устройствах видны без наведения. */}
      {!renaming && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CardAction icon={Pencil} title={t("lib.rename")} onClick={props.onRename} solid />
          <CardAction icon={Trash2} title={t("lib.delete")} onClick={props.onDelete} danger solid />
        </div>
      )}

      {/* Превью-плитка папки — тот же формат, что и у видео */}
      <div
        className={`relative mb-3 flex aspect-video w-full items-center justify-center overflow-hidden rounded-ui border-2 transition-colors ${
          hover
            ? "border-accent bg-accent/10"
            : "border-fog bg-gradient-to-br from-accent/10 to-accent/5 group-hover:border-accent"
        }`}
      >
        {hover ? (
          <FolderOpen
            className="h-12 w-12 text-accent transition-transform group-hover:scale-110"
            strokeWidth={1.75}
          />
        ) : (
          <Folder
            className="h-12 w-12 fill-accent-light/20 text-accent-light transition-transform group-hover:scale-110 group-hover:text-accent"
            strokeWidth={1.75}
          />
        )}
        <span className="absolute left-2 top-2 rounded-[4px] bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold uppercase text-snow">
          {t("lib.folder")}
        </span>
        <ChevronRight
          className="absolute bottom-2 right-2 h-4 w-4 text-accent opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={2.5}
        />
      </div>

      {renaming ? (
        <RenameInput {...props} />
      ) : (
        <h3 className="line-clamp-2 h-10 text-sm font-semibold leading-tight tracking-tight">
          {folder.name}
        </h3>
      )}
      {!renaming && <p className="mt-1 truncate text-xs font-semibold text-smoke">{t("lib.openFolderArrow")}</p>}
    </motion.div>
  );
}

// ── Карточка видео ─────────────────────────────────────────────────────────────
function VideoCard(props: {
  video: VideoRow;
  leaving: boolean;
  generating: boolean;
  selected: boolean;
  selectionMode: boolean;
  onToggleSelect: () => void;
  renaming: boolean;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onPlay: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCover: () => void;
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { video, leaving, generating, renaming, selected, selectionMode } = props;
  const { t } = useI18n();
  const audio = isAudioPath(video.file_path);

  // «Продолжить просмотр»: доля просмотренного из сохранённой позиции плеера.
  const watched = (() => {
    const raw = localStorage.getItem(`mestia.pos.${video.id}`);
    const pos = raw ? parseFloat(raw) : NaN;
    if (!Number.isFinite(pos) || pos <= 0 || !video.duration) return 0;
    return Math.min(1, pos / video.duration);
  })();

  // Клик: Ctrl/Cmd или режим выбора → переключить выделение; иначе — воспроизвести.
  const activate = (e: React.MouseEvent) => {
    if (renaming) return;
    if (e.ctrlKey || e.metaKey || selectionMode) props.onToggleSelect();
    else props.onPlay();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={leaving ? { opacity: 0, scale: 0.5 } : { opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      whileHover={leaving ? undefined : { y: -4 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      data-card
      data-video-id={video.id}
      draggable={props.draggable && !renaming}
      // нативный HTML5 DnD: типы расходятся с жестами motion, поэтому cast
      onDragStart={props.onDragStart as any}
      onDragEnd={props.onDragEnd as any}
      className={`mestia-anim group relative rounded-ui border-2 p-2.5 ${
        selected
          ? "border-accent bg-accent/5"
          : "border-transparent hover:border-fog hover:bg-paper/40"
      }`}
    >
      {/* Чекбокс выбора */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleSelect();
        }}
        title={t("lib.select")}
        className={`absolute left-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-md border-2 transition-all ${
          selected
            ? "border-accent bg-accent text-white"
            : "border-fog bg-snow/90 text-transparent"
        } ${
          selectionMode || selected
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </button>

      {/* Действия — на тач-устройствах (Steam Deck) видны без наведения. */}
      {!renaming && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CardAction icon={ImageIcon} title={t("lib.setCover")} onClick={props.onCover} solid />
          <CardAction icon={Pencil} title={t("lib.rename")} onClick={props.onRename} solid />
          <CardAction icon={Trash2} title={t("lib.delete")} onClick={props.onDelete} danger solid />
        </div>
      )}

      <div
        onClick={activate}
        className={`relative mb-3 flex aspect-video w-full cursor-pointer items-center justify-center overflow-hidden rounded-ui border-2 border-fog group-hover:border-accent ${
          audio ? "bg-accent/10" : "bg-fog"
        }`}
      >
        {video.thumbnail_path ? (
          <img
            src={
              /^https?:/i.test(video.thumbnail_path)
                ? video.thumbnail_path
                : convertFileSrc(video.thumbnail_path)
            }
            alt=""
            className="h-full w-full object-cover"
          />
        ) : null}
        {!video.thumbnail_path && !audio && generating && (
          <span className="mestia-skeleton absolute inset-0" />
        )}
        {audio ? (
          <Music className="absolute h-8 w-8 text-accent opacity-70 group-hover:opacity-100" strokeWidth={2.25} />
        ) : (
          <Play className="absolute h-8 w-8 text-accent opacity-60 group-hover:opacity-100" strokeWidth={2.25} />
        )}
        {/* Метка типа */}
        <span className="absolute left-2 top-2 rounded-[4px] bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold uppercase text-snow">
          {audio ? t("lib.audio") : t("lib.video")}
        </span>
        <span className="absolute bottom-2 right-2 rounded-[4px] bg-ink px-1.5 py-0.5 text-[10px] font-bold text-snow">
          {formatDuration(video.duration)}
        </span>
        {/* Полоса «продолжить просмотр» */}
        {watched > 0.02 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-ink/30">
            <div className="h-full bg-accent" style={{ width: `${watched * 100}%` }} />
          </div>
        )}
      </div>

      {renaming ? (
        <RenameInput {...props} />
      ) : (
        <h3
          onClick={activate}
          className="line-clamp-2 h-10 cursor-pointer text-sm font-semibold leading-tight hover:underline"
        >
          {video.title}
        </h3>
      )}
      <p className="mt-1 truncate text-xs font-semibold text-smoke">
        {audio ? t("lib.audio") : t("lib.video")} · {formatBytes(video.size)} · {video.platform ?? "—"}
      </p>
    </motion.div>
  );
}

// ── Пустое состояние ─────────────────────────────────────────────────────────
function EmptyState({ icon: Icon, text }: { icon: typeof Folder; text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mestia-anim flex flex-col items-center gap-3 py-20 text-center"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-fog bg-paper/40 text-smoke">
        <Icon className="h-6 w-6" strokeWidth={2} />
      </div>
      <p className="max-w-[280px] text-sm font-semibold text-smoke">{text}</p>
    </motion.div>
  );
}

// ── Инлайн-поле переименования ───────────────────────────────────────────────
function RenameInput(props: {
  renameValue: string;
  setRenameValue: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      value={props.renameValue}
      onChange={(e) => props.setRenameValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={props.onCommit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") props.onCommit();
        if (e.key === "Escape") props.onCancel();
      }}
      className="w-full rounded-ui border-2 border-accent bg-snow px-2 py-1 text-sm font-semibold outline-none"
    />
  );
}

// ── Кнопка-действие на карточке ──────────────────────────────────────────────
function CardAction({
  icon: Icon,
  title,
  onClick,
  danger,
  solid,
}: {
  icon: typeof Pencil;
  title: string;
  onClick: () => void;
  danger?: boolean;
  solid?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-ui p-1.5 transition-colors ${
        solid ? "border-2 border-fog bg-snow" : ""
      } ${danger ? "text-smoke hover:bg-rose-100 hover:text-rose-600" : "text-smoke hover:bg-fog hover:text-ink"}`}
    >
      <Icon className="h-4 w-4" strokeWidth={2.25} />
    </button>
  );
}
