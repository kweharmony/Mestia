import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { LogOut, PictureInPicture2, X } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Settings from "./components/Settings";
import Modal from "./components/Modal";
import Splash from "./components/Splash";
import UpdateModal from "./components/UpdateModal";
import DownloadsPanel from "./components/DownloadsPanel";
import Downloader from "./views/Downloader";
import Locker from "./views/Locker";
import History from "./views/History";
import Player from "./views/Player";
import { exitApp } from "./lib/ipc";
import { useDownloads } from "./context/DownloadsContext";
import { useI18n } from "./context/LanguageContext";
import type { TabId, VideoRow } from "./types";

export default function App() {
  const { hasActive } = useDownloads();
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>("downloader");
  const [playing, setPlaying] = useState<VideoRow | null>(null);
  const [playQueue, setPlayQueue] = useState<VideoRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storageVersion, setStorageVersion] = useState(0);
  const [closePrompt, setClosePrompt] = useState(false);

  // Экран запуска.
  const [booting, setBooting] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  useEffect(() => {
    const t1 = window.setTimeout(() => setSplashFading(true), 1500);
    const t2 = window.setTimeout(() => setBooting(false), 2050);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  // «Умное» закрытие окна (✕): решаем по наличию активных загрузок.
  const hasActiveRef = useRef(hasActive);
  hasActiveRef.current = hasActive;
  useEffect(() => {
    const un = listen("app://close-requested", () => {
      if (hasActiveRef.current) {
        getCurrentWindow().hide().catch(() => {});
      } else {
        setClosePrompt(true);
      }
    });
    return () => {
      un.then((u) => u());
    };
  }, []);

  function hideToTray() {
    getCurrentWindow().hide().catch(() => {});
  }

  function openPlayer(video: VideoRow, queue?: VideoRow[]) {
    setPlayQueue(queue ?? [video]);
    setPlaying(video);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-snow text-ink">
      <Sidebar
        active={tab}
        onChange={setTab}
        onOpenSettings={() => setSettingsOpen(true)}
        onHideToTray={hideToTray}
      />

      <main className="relative flex flex-1 flex-col overflow-y-auto">
        {tab === "downloader" && <Downloader onOpenSettings={() => setSettingsOpen(true)} />}
        {tab === "locker" && (
          <Locker key={storageVersion} onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")} />
        )}
        {tab === "history" && <History onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")} />}
      </main>

      <DownloadsPanel onOpenSettings={() => setSettingsOpen(true)} />

      {playing && (
        <Player
          key={playing.id}
          video={playing}
          queue={playQueue}
          onChange={setPlaying}
          onClose={() => setPlaying(null)}
        />
      )}

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onFolderChanged={() => setStorageVersion((v) => v + 1)}
      />

      {/* Диалог закрытия */}
      <Modal open={closePrompt} onClose={() => setClosePrompt(false)} z={60}>
        <div>
          <h3 className="text-base font-semibold tracking-tight">{t("app.closeTitle")}</h3>
          <p className="mt-1 text-sm font-semibold text-smoke">
            {t("app.closeText")}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => {
              setClosePrompt(false);
              hideToTray();
            }}
            className="flex items-center justify-center gap-2 rounded-ui border-2 border-ink bg-snow px-4 py-2.5 text-sm font-semibold hover:bg-fog"
          >
            <PictureInPicture2 className="h-4 w-4" strokeWidth={2.25} />
            {t("app.tray")}
          </button>
          <button
            onClick={() => exitApp()}
            className="flex items-center justify-center gap-2 rounded-ui bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            <LogOut className="h-4 w-4" strokeWidth={2.25} />
            {t("app.exit")}
          </button>
          <button
            onClick={() => setClosePrompt(false)}
            className="flex items-center justify-center gap-2 rounded-ui px-4 py-2 text-sm font-semibold text-smoke hover:text-ink"
          >
            <X className="h-4 w-4" strokeWidth={2.25} />
            {t("common.cancel")}
          </button>
        </div>
      </Modal>

      {booting && <Splash fading={splashFading} />}

      {/* Проверка обновлений при запуске (только главное окно) */}
      {!booting && <UpdateModal />}
    </div>
  );
}
