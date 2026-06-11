import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
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
  renameFolderRows,
  renameVideo,
  searchVideos,
  updateVideoThumb,
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
import Typewriter from "../components/Typewriter";

const SEARCH_HINTS = [
  "Поиск по всей библиотеке…",
  "Тот самый ролик про котиков?…",
  "Куда же я сохранил это видео…",
  "Введите название — найду вмиг 🐾",
  "Мемы, лекции, музыка… что ищем?",
  "Мяу? Имя файла подскажете?",
];

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

  // ── Фоновая генерация обложек для видео без превью ───────────────────────────
  const thumbAttempts = useRef<Set<number>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const v of videos) {
        if (cancelled) break;
        if (v.thumbnail_path || isAudioPath(v.file_path) || thumbAttempts.current.has(v.id)) {
          continue;
        }
        thumbAttempts.current.add(v.id);
        try {
          const thumb = await generateThumbnail(v.file_path);
          if (cancelled) break;
          await updateVideoThumb(v.id, thumb);
          setVideos((cur) =>
            cur.map((x) => (x.id === v.id ? { ...x, thumbnail_path: thumb } : x))
          );
        } catch {
          /* нет кадра — оставляем заглушку */
        }
      }
    })();
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

  async function reload() {
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
            if (!knownFiles.has(f.path)) {
              await insertVideo({
                title: f.name,
                url: null,
                file_path: f.path,
                duration: null,
                size: f.size,
                thumbnail_path: null,
                platform: "Локальный файл",
                folder_id: currentId,
              });
            }
          }
        }
      } catch {
        /* ошибки сканирования игнорируем */
      }
    }
    let folders = await listFolders(currentId);
    let vids = await listVideos(currentId);

    // Удаляем из библиотеки то, чего больше нет на диске (удалили/переместили вне приложения).
    try {
      const vEx = await existingPaths(vids.map((v) => v.file_path));
      await Promise.all(vids.filter((_, i) => !vEx[i]).map((v) => deleteVideoRow(v.id)));
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
    reload().catch((e) => notify(String(e), "error"));
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

  function enterFolder(folder: FolderRow) {
    setTrail((t) => [...t, folder]);
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
        filters: [{ name: "Изображения", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
      });
      if (typeof img !== "string") return;
      await updateVideoThumb(v.id, img);
      setVideos((cur) => cur.map((x) => (x.id === v.id ? { ...x, thumbnail_path: img } : x)));
      if (searchActive) setResults((cur) => cur.map((x) => (x.id === v.id ? { ...x, thumbnail_path: img } : x)));
      notify("Обложка обновлена");
    } catch (e) {
      notify(String(e), "error");
    }
  }

  async function handleCreateFolder() {
    const name = newName.trim();
    if (!name) return;
    try {
      const path = await createFolderOnDisk(name, current?.path ?? null);
      await createFolder(name, path, currentId);
      setNewName("");
      setCreating(false);
      await reload();
      notify(`Папка «${name}» создана`);
    } catch (e) {
      notify(String(e), "error");
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
            ? `Перемещено: ${toMove.length} → «${target.name}»`
            : `Перемещено в «${target.name}»`
        );
      }, 220);
    } catch (e) {
      setLeavingIds(new Set());
      notify(String(e), "error");
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
      notify("Переименовано");
    } catch (e) {
      notify(String(e), "error");
    }
  }

  function askDeleteVideo(v: VideoRow) {
    setConfirm({
      text: `Удалить «${v.title}» и файл с диска?`,
      action: async () => {
        await deleteFileOnDisk(v.file_path);
        await deleteVideoRow(v.id);
        await reload();
        notify("Видео удалено");
      },
    });
  }
  function askDeleteFolder(f: FolderRow) {
    setConfirm({
      text: `Удалить папку «${f.name}» со всем содержимым?`,
      action: async () => {
        await deleteFolderOnDisk(f.path);
        await deleteFolderTree(f.id);
        await reload();
        notify("Папка удалена");
      },
    });
  }
  function askDeleteSelected() {
    const vids = displayed.filter((v) => selected.has(v.id));
    if (!vids.length) return;
    setConfirm({
      text: `Удалить выбранные видео (${vids.length}) и файлы с диска?`,
      action: async () => {
        for (const v of vids) {
          await deleteFileOnDisk(v.file_path);
          await deleteVideoRow(v.id);
        }
        setSelected(new Set());
        await reload();
        notify(`Удалено: ${vids.length}`);
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
                dropMove({ id: null, path: storageRoot, name: "Медиатека" });
              }}
              className={`rounded-ui px-1 ${
                hoverCrumb === "root" ? "bg-accent/20 ring-2 ring-accent" : ""
              } ${trail.length ? "text-smoke hover:text-ink" : ""}`}
            >
              Медиатека
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
              onClick={() => reload().catch((e) => notify(String(e), "error"))}
              title="Обновить"
              className="mestia-nav flex items-center justify-center rounded-ui border-2 border-fog p-2 hover:bg-fog"
            >
              <RefreshCw className="mestia-ico-gear h-4 w-4" strokeWidth={2.25} />
            </button>
            <button
              onClick={() => openFolder(currentPath).catch((e) => notify(String(e), "error"))}
              title="Открыть в проводнике"
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
                  placeholder="Название папки"
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
                Новая папка
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
              <Typewriter phrases={SEARCH_HINTS} className="whitespace-nowrap" />
            </div>
          )}
          {searchActive && (
            <button onClick={() => setQuery("")} className="text-smoke hover:text-ink">
              <X className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
        </div>

        {/* Панель выбора */}
        {selectionMode && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-ui border-2 border-accent bg-accent/10 px-4 py-2.5">
            <span className="text-sm font-semibold">Выбрано: {selected.size}</span>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="hidden text-smoke md:inline">перетащите на папку для переноса</span>
              <button
                onClick={() => setSelected(new Set(displayed.map((v) => v.id)))}
                className="rounded-ui border-2 border-ink px-3 py-1.5 hover:bg-fog"
              >
                Выбрать все
              </button>
              <button
                onClick={askDeleteSelected}
                className="flex items-center gap-1.5 rounded-ui border-2 border-ink bg-rose-600 px-3 py-1.5 text-white hover:opacity-90"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2.25} />
                Удалить
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="rounded-ui border-2 border-fog px-3 py-1.5 hover:bg-fog"
              >
                Снять
              </button>
            </div>
          </div>
        )}

        {/* Контент — с выделением рамкой */}
        <div ref={gridRef} onMouseDown={onGridMouseDown} className="relative min-h-[300px]">
        {searchActive ? (
          results.length === 0 ? (
            <div className="py-16 text-center text-sm font-semibold text-smoke">
              Ничего не найдено по запросу «{query}».
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              {results.map((v) => (
                <VideoCard
                  key={`s-${v.id}`}
                  video={v}
                  leaving={leavingIds.has(v.id)}
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
            </div>
          )
        ) : folders.length === 0 && videos.length === 0 ? (
          <div className="py-16 text-center text-sm font-semibold text-smoke">
            {trail.length ? "В этой папке пусто." : "Пусто. Скачайте видео во вкладке «Загрузчик»."}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
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
            {videos.map((video) => (
              <VideoCard
                key={`v-${video.id}`}
                video={video}
                leaving={leavingIds.has(video.id)}
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
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
          onClick={() => setConfirm(null)}
        >
          <div
            className="w-full max-w-[380px] space-y-5 rounded-ui border-2 border-ink bg-snow p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold leading-snug">{confirm.text}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                Отмена
              </button>
              <button
                onClick={async () => {
                  const act = confirm.action;
                  setConfirm(null);
                  try {
                    await act();
                  } catch (e) {
                    notify(String(e), "error");
                  }
                }}
                className="flex items-center gap-2 rounded-ui border-2 border-ink bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <Trash2 className="h-4 w-4" strokeWidth={2.25} />
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
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
  return (
    <div
      data-card
      onClick={() => !renaming && props.onEnter()}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      className={`group relative flex cursor-pointer items-center justify-between rounded-ui border-2 bg-paper p-4 no-select ${
        hover
          ? "scale-[1.03] border-accent bg-snow"
          : "border-fog hover:-translate-y-0.5 hover:border-accent hover:bg-snow"
      }`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-2 border-fog bg-snow text-accent-light transition-all duration-300 group-hover:bg-accent-light group-hover:text-white">
          <Folder className="h-5 w-5 fill-current" strokeWidth={2.25} />
        </div>
        {renaming ? (
          <RenameInput {...props} />
        ) : (
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-tight">{folder.name}</span>
            <span className="text-[11px] font-bold text-smoke">папка</span>
          </div>
        )}
      </div>

      {!renaming && (
        <div className="flex shrink-0 items-center gap-1">
          <CardAction icon={Pencil} title="Переименовать" onClick={props.onRename} />
          <CardAction icon={Trash2} title="Удалить" onClick={props.onDelete} danger />
          <ChevronRight
            className="ml-1 h-4 w-4 text-accent opacity-0 transition-all group-hover:opacity-100"
            strokeWidth={2.25}
          />
        </div>
      )}
    </div>
  );
}

// ── Карточка видео ─────────────────────────────────────────────────────────────
function VideoCard(props: {
  video: VideoRow;
  leaving: boolean;
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
  const { video, leaving, renaming, selected, selectionMode } = props;
  const audio = isAudioPath(video.file_path);

  // Клик: Ctrl/Cmd или режим выбора → переключить выделение; иначе — воспроизвести.
  const activate = (e: React.MouseEvent) => {
    if (renaming) return;
    if (e.ctrlKey || e.metaKey || selectionMode) props.onToggleSelect();
    else props.onPlay();
  };

  return (
    <div
      data-card
      data-video-id={video.id}
      draggable={props.draggable && !renaming}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      style={leaving ? { opacity: 0, transform: "scale(0.5)" } : undefined}
      className={`group relative rounded-ui border-2 p-2.5 transition-all duration-300 ${
        selected
          ? "border-accent bg-accent/5"
          : "border-transparent hover:-translate-y-1 hover:border-fog hover:bg-paper/40"
      }`}
    >
      {/* Чекбокс выбора */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleSelect();
        }}
        title="Выбрать"
        className={`absolute left-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-md border-2 transition-all ${
          selected
            ? "border-accent bg-accent text-white"
            : "border-fog bg-snow/90 text-transparent"
        } ${selectionMode || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </button>

      {/* Действия */}
      {!renaming && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <CardAction icon={ImageIcon} title="Сменить обложку" onClick={props.onCover} solid />
          <CardAction icon={Pencil} title="Переименовать" onClick={props.onRename} solid />
          <CardAction icon={Trash2} title="Удалить" onClick={props.onDelete} danger solid />
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
        {audio ? (
          <Music className="absolute h-8 w-8 text-accent opacity-70 group-hover:opacity-100" strokeWidth={2.25} />
        ) : (
          <Play className="absolute h-8 w-8 text-accent opacity-60 group-hover:opacity-100" strokeWidth={2.25} />
        )}
        {/* Метка типа */}
        <span className="absolute left-2 top-2 rounded-[4px] bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold uppercase text-snow">
          {audio ? "Аудио" : "Видео"}
        </span>
        <span className="absolute bottom-2 right-2 rounded-[4px] bg-ink px-1.5 py-0.5 text-[10px] font-bold text-snow">
          {formatDuration(video.duration)}
        </span>
      </div>

      {renaming ? (
        <RenameInput {...props} />
      ) : (
        <h3
          onClick={activate}
          className="line-clamp-2 cursor-pointer text-sm font-semibold leading-tight hover:underline"
        >
          {video.title}
        </h3>
      )}
      <p className="mt-1 text-xs font-semibold text-smoke">
        {audio ? "Аудио" : "Видео"} · {formatBytes(video.size)} · {video.platform ?? "—"}
      </p>
    </div>
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
