import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
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
import Nearby from "./views/Nearby";
import Room from "./views/Room";
import { exitApp, moveAppToBack, takeSharedText } from "./lib/ipc";
import { IS_ANDROID } from "./lib/platform";
import { useDownloads } from "./context/DownloadsContext";
import { useLan } from "./context/LanContext";
import { useI18n } from "./context/LanguageContext";
import type { TabId, VideoRow } from "./types";

export default function App() {
  const { hasActive } = useDownloads();
  const { t } = useI18n();
  const { room, closeRoom } = useLan();
  const [tab, setTab] = useState<TabId>("downloader");
  const [playing, setPlaying] = useState<VideoRow | null>(null);
  const [playQueue, setPlayQueue] = useState<VideoRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storageVersion, setStorageVersion] = useState(0);
  const [closePrompt, setClosePrompt] = useState(false);
  // Ссылка из «Поделиться → Mestia» (Android); n — чтобы повторная та же ссылка тоже сработала.
  const [shared, setShared] = useState<{ text: string; n: number } | null>(null);

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

  // Android: забираем ссылку из «Поделиться» при запуске и при каждом возврате в
  // приложение (singleTask-активити не перезапускается — intent приходит в onNewIntent).
  useEffect(() => {
    if (!IS_ANDROID) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      takeSharedText()
        .then((text) => {
          if (!text) return;
          setPlaying(null);
          setSettingsOpen(false);
          setTab("downloader");
          setShared((s) => ({ text, n: (s?.n ?? 0) + 1 }));
        })
        .catch(() => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  // Android: системная «Назад» закрывает плеер/настройки, затем ведёт на первую
  // вкладку, а с неё сворачивает приложение (не убивая фоновые загрузки).
  const backState = useRef({ playing, settingsOpen, tab, room, closeRoom });
  backState.current = { playing, settingsOpen, tab, room, closeRoom };
  useEffect(() => {
    if (!IS_ANDROID) return;
    const sub = onBackButtonPress(() => {
      // Сначала даём плееру выйти из полноэкранного режима (он отменяет событие).
      const ev = new Event("mestia:back", { cancelable: true });
      if (!window.dispatchEvent(ev)) return;
      const s = backState.current;
      if (s.room) s.closeRoom();
      else if (s.playing) setPlaying(null);
      else if (s.settingsOpen) setSettingsOpen(false);
      else if (s.tab !== "downloader") setTab("downloader");
      else moveAppToBack().catch(() => {});
    });
    return () => {
      sub.then((l) => l.unregister()).catch(() => {});
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

      <main className="relative flex flex-1 flex-col overflow-y-auto pb-16 md:pb-0">
        {tab === "downloader" && <Downloader onOpenSettings={() => setSettingsOpen(true)} incoming={shared} />}
        {tab === "locker" && (
          <Locker key={storageVersion} onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")} />
        )}
        {tab === "history" && <History onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")} />}
        {tab === "nearby" && <Nearby />}
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

      {room && <Room room={room} />}

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
