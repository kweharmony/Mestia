import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import {
  AlertTriangle,
  Bell,
  FolderCog,
  FolderOpen,
  Layers,
  Loader2,
  Palette,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  exitApp,
  getSetting,
  getStorageRoot,
  openFolder,
  setSetting,
  setStorageRoot,
  uninstallApp,
  updateYtdlp,
} from "../lib/ipc";
import ThemeSwitcher from "./ThemeSwitcher";
import { useToast } from "./Toast";
import { useDownloads } from "../context/DownloadsContext";

export default function Settings({
  onClose,
  onFolderChanged,
}: {
  onClose: () => void;
  onFolderChanged: () => void;
}) {
  const { notify } = useToast();
  const { hasActive } = useDownloads();
  const [path, setPath] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [parallel, setParallel] = useState(2);
  const [updating, setUpdating] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [deleteContent, setDeleteContent] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  useEffect(() => {
    getStorageRoot().then(setPath).catch(() => {});
    getSetting("notifications").then((v) => setNotifications(v === "1")).catch(() => {});
    getSetting("maxParallel")
      .then((v) => {
        const n = parseInt(v ?? "2", 10);
        setParallel(Number.isNaN(n) ? 2 : Math.min(5, Math.max(1, n)));
      })
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pickFolder() {
    if (hasActive) {
      notify("Нельзя менять папку во время загрузки", "error");
      return;
    }
    try {
      const dir = await open({ directory: true, multiple: false, defaultPath: path || undefined });
      if (typeof dir === "string") {
        const applied = await setStorageRoot(dir);
        setPath(applied);
        onFolderChanged();
        notify("Папка загрузок обновлена");
      }
    } catch (e) {
      notify(String(e), "error");
    }
  }

  async function toggleNotifications() {
    const next = !notifications;
    if (next) {
      let granted = await isPermissionGranted().catch(() => false);
      if (!granted) granted = (await requestPermission().catch(() => "denied")) === "granted";
      if (!granted) {
        notify("Уведомления запрещены в системе", "error");
        return;
      }
    }
    setNotifications(next);
    await setSetting("notifications", next ? "1" : "0").catch(() => {});
  }

  async function changeParallel(n: number) {
    setParallel(n);
    await setSetting("maxParallel", String(n)).catch(() => {});
  }

  async function handleUninstall() {
    setUninstalling(true);
    try {
      await uninstallApp(deleteContent);
      await exitApp();
    } catch (e) {
      setUninstalling(false);
      notify(`Не удалось удалить: ${e}`, "error");
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      const msg = await updateYtdlp();
      notify(msg.slice(0, 80) || "yt-dlp обновлён");
    } catch (e) {
      notify(`Не удалось обновить: ${e}`, "error");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="mestia-anim fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="mestia-anim max-h-[88vh] w-full max-w-[520px] space-y-7 overflow-y-auto rounded-ui border-2 border-ink bg-snow p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Настройки</h2>
          <button
            onClick={onClose}
            className="rounded-ui p-1.5 text-smoke hover:bg-fog hover:text-ink"
          >
            <X className="h-5 w-5" strokeWidth={2.25} />
          </button>
        </div>

        {/* Папка загрузок */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FolderCog className="h-4 w-4 text-accent" strokeWidth={2.25} />
            Папка загрузок
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded-ui border-2 border-fog bg-paper/40 px-3 py-2 text-sm font-semibold">
              {path || "—"}
            </div>
            <button
              onClick={() => openFolder(path).catch((e) => notify(String(e), "error"))}
              title="Открыть в проводнике"
              className="rounded-ui border-2 border-fog p-2 hover:bg-fog"
            >
              <FolderOpen className="h-4 w-4" strokeWidth={2.25} />
            </button>
            <button
              onClick={pickFolder}
              disabled={hasActive}
              className="rounded-ui border-2 border-ink px-4 py-2 text-sm font-semibold hover:bg-fog disabled:cursor-not-allowed disabled:opacity-50"
            >
              Изменить
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {hasActive
              ? "Смена папки недоступна, пока идут загрузки."
              : "Применяется к новым загрузкам. Уже скачанные файлы не переносятся."}
          </p>
        </section>

        {/* Одновременные загрузки */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-accent" strokeWidth={2.25} />
              Одновременных загрузок
            </span>
            <span className="text-accent">{parallel}</span>
          </div>
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => {
              const active = parallel === n;
              return (
                <button
                  key={n}
                  onClick={() => changeParallel(n)}
                  className={`relative flex-1 rounded-ui border-2 border-transparent py-1.5 text-sm font-semibold ${
                    active ? "text-accent" : "hover:bg-fog"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="parallelPill"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-accent bg-snow"
                    />
                  )}
                  <span className="relative z-10">{n}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs font-semibold text-smoke">
            Остальные задачи становятся в очередь.
          </p>
        </section>

        {/* Уведомления */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4 text-accent" strokeWidth={2.25} />
              Уведомления на рабочий стол
            </span>
            <button
              onClick={toggleNotifications}
              className={`relative h-6 w-11 rounded-full border-2 transition-all ${
                notifications ? "border-accent bg-accent" : "border-fog bg-fog"
              }`}
            >
              <motion.span
                animate={{ x: notifications ? 20 : 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 32 }}
                className="mestia-anim absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-snow"
              />
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            Сообщать о завершении загрузки, даже когда окно свёрнуто.
          </p>
        </section>

        {/* Движок yt-dlp */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-accent" strokeWidth={2.25} />
              Движок yt-dlp
            </span>
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="flex items-center gap-2 rounded-ui border-2 border-ink px-3 py-1.5 text-xs font-semibold hover:bg-fog disabled:opacity-50"
            >
              <AnimatePresence mode="wait" initial={false}>
                {updating ? (
                  <motion.span
                    key="u-spin"
                    className="mestia-anim"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                  </motion.span>
                ) : (
                  <motion.span
                    key="u-ref"
                    className="mestia-anim"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ duration: 0.15 }}
                  >
                    <RefreshCw className="h-4 w-4" strokeWidth={2.25} />
                  </motion.span>
                )}
              </AnimatePresence>
              Обновить
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            Если какой-то сайт перестал работать — обновите движок.
          </p>
        </section>

        {/* Тема */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Palette className="h-4 w-4 text-accent" strokeWidth={2.25} />
            Тема оформления
          </div>
          <ThemeSwitcher />
          <p className="text-xs font-semibold text-smoke">
            Верхний ряд — светлые, нижний — тёмные.
          </p>
        </section>

        {/* Удаление приложения */}
        <section className="space-y-3 border-t-2 border-fog pt-6">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-500" strokeWidth={2.25} />
              Удалить приложение
            </span>
            <button
              onClick={() => {
                setDeleteContent(false);
                setConfirmUninstall(true);
              }}
              className="rounded-ui border-2 border-rose-500 px-3 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-500 hover:text-white"
            >
              Удалить
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            Сотрёт данные приложения и запустит деинсталляцию.
          </p>
        </section>
      </motion.div>

      {/* Подтверждение удаления приложения */}
      <AnimatePresence>
        {confirmUninstall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mestia-anim fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
            onClick={(e) => {
              e.stopPropagation();
              if (!uninstalling) setConfirmUninstall(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="mestia-anim w-full max-w-[420px] space-y-5 rounded-ui border-2 border-rose-500 bg-snow p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 shrink-0 text-rose-500" strokeWidth={2.25} />
                <h3 className="text-base font-semibold tracking-tight">Удалить Mestia?</h3>
              </div>
              <p className="text-sm font-semibold text-smoke">
                Будут стёрты данные приложения (история, медиатека, настройки) и
                запущена деинсталляция. Действие необратимо.
              </p>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-ui border-2 border-fog bg-paper/40 p-3">
                <input
                  type="checkbox"
                  checked={deleteContent}
                  onChange={(e) => setDeleteContent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-rose-500"
                />
                <span className="text-sm font-semibold">
                  Также удалить скачанные файлы
                  <span className="mt-0.5 block text-xs font-semibold text-smoke">
                    Папка загрузок со всем видео/аудио. Иначе файлы останутся на диске.
                  </span>
                </span>
              </label>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmUninstall(false)}
                  disabled={uninstalling}
                  className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={handleUninstall}
                  disabled={uninstalling}
                  className="flex items-center gap-2 rounded-ui border-2 border-rose-600 bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {uninstalling ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                  ) : (
                    <Trash2 className="h-4 w-4" strokeWidth={2.25} />
                  )}
                  Удалить приложение
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
