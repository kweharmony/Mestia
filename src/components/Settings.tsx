import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  AlertTriangle,
  Bell,
  Captions,
  Cookie,
  FastForward,
  FolderCog,
  Gauge,
  FolderOpen,
  Globe,
  Languages,
  Layers,
  Loader2,
  Palette,
  RefreshCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import {
  exitApp,
  getSetting,
  getStorageRoot,
  humanizeError,
  openFolder,
  setSetting,
  setStorageRoot,
  uninstallApp,
  updateYtdlp,
} from "../lib/ipc";
import Modal from "./Modal";
import ThemeSwitcher from "./ThemeSwitcher";
import { useToast } from "./Toast";
import { useDownloads } from "../context/DownloadsContext";
import { useI18n } from "../context/LanguageContext";
import { LANGS, LANG_LABELS } from "../lib/i18n";

export default function Settings({
  open,
  onClose,
  onFolderChanged,
}: {
  open: boolean;
  onClose: () => void;
  onFolderChanged: () => void;
}) {
  const { notify } = useToast();
  const { hasActive } = useDownloads();
  const { t, lang, setLang } = useI18n();
  const [path, setPath] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [parallel, setParallel] = useState(2);
  const [fragments, setFragments] = useState(5);
  const [skip, setSkip] = useState(15);
  const [cookiesBrowser, setCookiesBrowser] = useState("");
  const [proxy, setProxy] = useState("");
  const [subtitles, setSubtitles] = useState(false);
  const [subtitlesLang, setSubtitlesLang] = useState("ru,en");
  const [sponsorblock, setSponsorblock] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [deleteContent, setDeleteContent] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  useEffect(() => {
    if (!open) return; // подгружаем настройки только при открытии окна
    getStorageRoot().then(setPath).catch(() => {});
    getSetting("notifications").then((v) => setNotifications(v === "1")).catch(() => {});
    getSetting("maxParallel")
      .then((v) => {
        const n = parseInt(v ?? "2", 10);
        setParallel(Number.isNaN(n) ? 2 : Math.min(5, Math.max(1, n)));
      })
      .catch(() => {});
    getSetting("concurrentFragments")
      .then((v) => {
        const n = parseInt(v ?? "5", 10);
        setFragments(Number.isNaN(n) ? 5 : Math.min(16, Math.max(1, n)));
      })
      .catch(() => {});
    getSetting("skipSeconds")
      .then((v) => {
        const n = parseInt(v ?? "15", 10);
        setSkip(Number.isNaN(n) ? 15 : Math.min(120, Math.max(5, n)));
      })
      .catch(() => {});
    getSetting("cookiesBrowser").then((v) => setCookiesBrowser(v ?? "")).catch(() => {});
    getSetting("proxy").then((v) => setProxy(v ?? "")).catch(() => {});
    getSetting("subtitles").then((v) => setSubtitles(v === "1")).catch(() => {});
    getSetting("subtitlesLang").then((v) => v && setSubtitlesLang(v)).catch(() => {});
    getSetting("sponsorblock").then((v) => setSponsorblock(v === "1")).catch(() => {});
  }, [open]);

  async function pickFolder() {
    if (hasActive) {
      notify(t("set.folderBusy"), "error");
      return;
    }
    try {
      const dir = await openDialog({ directory: true, multiple: false, defaultPath: path || undefined });
      if (typeof dir === "string") {
        const applied = await setStorageRoot(dir);
        setPath(applied);
        onFolderChanged();
        notify(t("set.folderUpdated"));
      }
    } catch (e) {
      notify(humanizeError(e), "error");
    }
  }

  async function toggleNotifications() {
    const next = !notifications;
    if (next) {
      let granted = await isPermissionGranted().catch(() => false);
      if (!granted) granted = (await requestPermission().catch(() => "denied")) === "granted";
      if (!granted) {
        notify(t("set.notifDenied"), "error");
        return;
      }
    }
    setNotifications(next);
    await setSetting("notifications", next ? "1" : "0").catch(() => {});
    if (next) void testNotification(); // сразу показываем, что работает
  }

  async function testNotification() {
    try {
      let granted = await isPermissionGranted().catch(() => false);
      if (!granted) granted = (await requestPermission().catch(() => "denied")) === "granted";
      if (!granted) {
        notify(t("set.notifDenied"), "error");
        return;
      }
      sendNotification({ title: "Mestia", body: t("set.notifWorks") });
    } catch (e) {
      notify(t("set.notifSendFail", { err: humanizeError(e) }), "error");
    }
  }

  async function changeParallel(n: number) {
    setParallel(n);
    await setSetting("maxParallel", String(n)).catch(() => {});
  }

  async function changeFragments(n: number) {
    setFragments(n);
    await setSetting("concurrentFragments", String(n)).catch(() => {});
  }

  async function changeSkip(n: number) {
    setSkip(n);
    await setSetting("skipSeconds", String(n)).catch(() => {});
  }

  async function changeCookies(b: string) {
    setCookiesBrowser(b);
    await setSetting("cookiesBrowser", b).catch(() => {});
  }

  async function changeProxy(v: string) {
    setProxy(v);
    await setSetting("proxy", v.trim()).catch(() => {});
  }

  async function toggleSubtitles() {
    const next = !subtitles;
    setSubtitles(next);
    await setSetting("subtitles", next ? "1" : "0").catch(() => {});
  }

  async function changeSubtitlesLang(v: string) {
    setSubtitlesLang(v);
    await setSetting("subtitlesLang", v.trim() || "ru,en").catch(() => {});
  }

  async function toggleSponsorblock() {
    const next = !sponsorblock;
    setSponsorblock(next);
    await setSetting("sponsorblock", next ? "1" : "0").catch(() => {});
  }

  async function handleUninstall() {
    setUninstalling(true);
    try {
      await uninstallApp(deleteContent);
      await exitApp();
    } catch (e) {
      setUninstalling(false);
      notify(t("set.uninstallFail", { err: humanizeError(e) }), "error");
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      const msg = await updateYtdlp();
      notify(msg.slice(0, 80) || t("dp.updated"));
    } catch (e) {
      notify(t("set.updateFail", { err: humanizeError(e) }), "error");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      cardClassName="mestia-anim max-h-[88vh] w-full max-w-[520px] space-y-7 overflow-y-auto rounded-ui border-2 border-ink bg-snow p-7"
    >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">{t("set.title")}</h2>
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
            {t("set.downloadFolder")}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded-ui border-2 border-fog bg-paper/40 px-3 py-2 text-sm font-semibold">
              {path || "—"}
            </div>
            <button
              onClick={() => openFolder(path).catch((e) => notify(humanizeError(e), "error"))}
              title={t("lib.openExplorer")}
              className="rounded-ui border-2 border-fog p-2 hover:bg-fog"
            >
              <FolderOpen className="h-4 w-4" strokeWidth={2.25} />
            </button>
            <button
              onClick={pickFolder}
              disabled={hasActive}
              className="rounded-ui border-2 border-ink px-4 py-2 text-sm font-semibold hover:bg-fog disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("common.change")}
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {hasActive ? t("set.folderBusy") : t("set.folderApplies")}
          </p>
        </section>

        {/* Одновременные загрузки */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-accent" strokeWidth={2.25} />
              {t("set.parallel")}
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
            {t("set.parallelHint")}
          </p>
        </section>

        {/* Скорость загрузки (потоки на видео) */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="h-4 w-4 text-accent" strokeWidth={2.25} />
            {t("set.speed")}
          </div>
          <div className="flex gap-1.5">
            {[
              { label: t("set.speedNormal"), v: 3 },
              { label: t("set.speedFast"), v: 5 },
              { label: t("set.speedMax"), v: 10 },
            ].map((opt) => {
              const active = fragments === opt.v;
              return (
                <button
                  key={opt.v}
                  onClick={() => changeFragments(opt.v)}
                  className={`relative flex-1 rounded-ui border-2 border-transparent py-1.5 text-sm font-semibold ${
                    active ? "text-accent" : "hover:bg-fog"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="speedPill"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-accent bg-snow"
                    />
                  )}
                  <span className="relative z-10">{opt.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.speedHint")}
          </p>
        </section>

        {/* Шаг перемотки в плеере */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FastForward className="h-4 w-4 text-accent" strokeWidth={2.25} />
            {t("set.skip")}
          </div>
          <div className="flex gap-1.5">
            {[5, 10, 15, 30].map((n) => {
              const active = skip === n;
              return (
                <button
                  key={n}
                  onClick={() => changeSkip(n)}
                  className={`relative flex-1 rounded-ui border-2 border-transparent py-1.5 text-sm font-semibold ${
                    active ? "text-accent" : "hover:bg-fog"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="skipPill"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      className="mestia-anim absolute -inset-[2px] z-0 rounded-ui border-2 border-accent bg-snow"
                    />
                  )}
                  <span className="relative z-10">{n}{lang === "zh" ? " 秒" : lang === "en" ? "s" : " с"}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.skipHint")}
          </p>
        </section>

        {/* Уведомления */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4 text-accent" strokeWidth={2.25} />
              {t("set.notifications")}
            </span>
            <div className="flex items-center gap-2">
              {notifications && (
                <button
                  onClick={testNotification}
                  className="rounded-ui border-2 border-fog px-3 py-1 text-xs font-semibold hover:bg-fog"
                >
                  {t("set.test")}
                </button>
              )}
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
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.notificationsHint")}
          </p>
        </section>

        {/* Куки из браузера */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Cookie className="h-4 w-4 text-accent" strokeWidth={2.25} />
              {t("set.cookies")}
            </span>
            <select
              value={cookiesBrowser}
              onChange={(e) => changeCookies(e.target.value)}
              className="rounded-ui border-2 border-fog bg-snow px-2 py-1.5 text-sm font-semibold text-ink outline-none focus:border-accent"
            >
              <option value="">{t("set.cookiesOff")}</option>
              <option value="chrome">Chrome</option>
              <option value="firefox">Firefox</option>
              <option value="edge">Edge</option>
              <option value="brave">Brave</option>
              <option value="opera">Opera</option>
              <option value="vivaldi">Vivaldi</option>
              <option value="chromium">Chromium</option>
            </select>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.cookiesHint")}
          </p>
        </section>

        {/* Прокси */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4 text-accent" strokeWidth={2.25} />
            {t("set.proxy")}
          </div>
          <input
            value={proxy}
            onChange={(e) => changeProxy(e.target.value)}
            placeholder={t("set.proxyPlaceholder")}
            className="w-full rounded-ui border-2 border-fog bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none focus:border-accent"
          />
          <p className="text-xs font-semibold text-smoke">
            {t("set.proxyHint")}
          </p>
        </section>

        {/* Язык интерфейса */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Languages className="h-4 w-4 text-accent" strokeWidth={2.25} />
              {t("set.language")}
            </span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as (typeof LANGS)[number])}
              className="rounded-ui border-2 border-fog bg-snow px-2 py-1.5 text-sm font-semibold text-ink outline-none focus:border-accent"
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {LANG_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.languageHint")}
          </p>
        </section>

        {/* Субтитры */}
        <section className="space-y-3">
          <Toggle
            icon={<Captions className="h-4 w-4 text-accent" strokeWidth={2.25} />}
            label={t("set.subtitles")}
            on={subtitles}
            onToggle={toggleSubtitles}
          />
          {subtitles && (
            <input
              value={subtitlesLang}
              onChange={(e) => changeSubtitlesLang(e.target.value)}
              placeholder={t("set.subtitlesPlaceholder")}
              className="w-full rounded-ui border-2 border-fog bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none focus:border-accent"
            />
          )}
          <p className="text-xs font-semibold text-smoke">
            {t("set.subtitlesHint")}
          </p>
        </section>

        {/* SponsorBlock */}
        <section className="space-y-3">
          <Toggle
            icon={<Scissors className="h-4 w-4 text-accent" strokeWidth={2.25} />}
            label={t("set.sponsorblock")}
            on={sponsorblock}
            onToggle={toggleSponsorblock}
          />
          <p className="text-xs font-semibold text-smoke">
            {t("set.sponsorblockHint")}
          </p>
        </section>

        {/* Движок yt-dlp */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-accent" strokeWidth={2.25} />
              {t("set.engine")}
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
              {t("set.update")}
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.engineHint")}
          </p>
        </section>

        {/* Тема */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Palette className="h-4 w-4 text-accent" strokeWidth={2.25} />
            {t("set.theme")}
          </div>
          <ThemeSwitcher />
          <p className="text-xs font-semibold text-smoke">
            {t("set.themeHint")}
          </p>
        </section>

        {/* Удаление приложения */}
        <section className="space-y-3 border-t-2 border-fog pt-6">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-500" strokeWidth={2.25} />
              {t("set.uninstall")}
            </span>
            <button
              onClick={() => {
                setDeleteContent(false);
                setConfirmUninstall(true);
              }}
              className="rounded-ui border-2 border-rose-500 px-3 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-500 hover:text-white"
            >
              {t("lib.delete")}
            </button>
          </div>
          <p className="text-xs font-semibold text-smoke">
            {t("set.uninstallHint")}
          </p>
        </section>
    </Modal>

      {/* Подтверждение удаления приложения */}
      <Modal
        open={confirmUninstall}
        onClose={() => !uninstalling && setConfirmUninstall(false)}
        z={60}
        cardClassName="mestia-anim w-full max-w-[420px] space-y-5 rounded-ui border-2 border-rose-500 bg-snow p-6"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 shrink-0 text-rose-500" strokeWidth={2.25} />
          <h3 className="text-base font-semibold tracking-tight">{t("set.uninstallTitle")}</h3>
        </div>
        <p className="text-sm font-semibold text-smoke">
          {t("set.uninstallText")}
        </p>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-ui border-2 border-fog bg-paper/40 p-3">
          <input
            type="checkbox"
            checked={deleteContent}
            onChange={(e) => setDeleteContent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-rose-500"
          />
          <span className="text-sm font-semibold">
            {t("set.alsoDeleteFiles")}
            <span className="mt-0.5 block text-xs font-semibold text-smoke">
              {t("set.alsoDeleteFilesHint")}
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setConfirmUninstall(false)}
            disabled={uninstalling}
            className="rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50"
          >
            {t("common.cancel")}
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
            {t("set.uninstall")}
          </button>
        </div>
      </Modal>
    </>
  );
}

/** Переключатель «вкл/выкл» с иконкой и подписью (общий вид для секций). */
function Toggle({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {label}
      </span>
      <button
        onClick={onToggle}
        className={`relative h-6 w-11 rounded-full border-2 transition-all ${
          on ? "border-accent bg-accent" : "border-fog bg-fog"
        }`}
      >
        <motion.span
          animate={{ x: on ? 20 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 32 }}
          className="mestia-anim absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-snow"
        />
      </button>
    </div>
  );
}
