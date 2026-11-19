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
import Addons from "./views/Addons";
import Transcription from "./views/Transcription";
import CommandPalette from "./components/CommandPalette";
import Downloader from "./views/Downloader";
import Locker from "./views/Locker";
import History from "./views/History";
import Player from "./views/Player";
import Nearby from "./views/Nearby";
import Room from "./views/Room";
import {
  addonPackages, exitApp, installAddonPackage, moveAppToBack, takeSharedText, transcriptionAddonStatus,
  uninstallAddonPackage, type AddonPackageId, type AddonPackageStatus,
} from "./lib/ipc";
import { IS_ANDROID } from "./lib/platform";
import { useDownloads } from "./context/DownloadsContext";
import { LanProvider, useLan } from "./context/LanContext";
import { useI18n } from "./context/LanguageContext";
import type { TabId, VideoRow } from "./types";

type CatalogState = {
  transcription?: boolean | null;
  packages?: Record<AddonPackageId, AddonPackageStatus>;
};
const RESUME_ADDONS = "mestia.resumeAddons";

export default function App() {
  const [catalog, setCatalog] = useState<CatalogState>({});
  const [catalogError, setCatalogError] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setCatalogError(false);
    async function loadCatalog() {
      if (!IS_ANDROID) {
        const transcription = await transcriptionAddonStatus();
        if (!active) return;
        setCatalog((current) => current.transcription === undefined ? { ...current, transcription } : current);
        if (transcription === null) return;
      }
      const packages = await addonPackages();
      if (active) setCatalog((current) => ({ ...current, packages }));
    }
    void loadCatalog().catch((error) => {
      if (!active) return;
      console.error(error);
      setCatalogError(true);
    });
    return () => { active = false; };
  }, [catalogAttempt]);

  const nearbyEnabled = catalog.transcription === null || catalog.packages?.nearby.installed === true;
  return (
    <LanProvider enabled={nearbyEnabled}>
      <AppContent catalog={catalog} nearbyEnabled={nearbyEnabled}
        catalogError={catalogError} onCatalogRetry={() => setCatalogAttempt((n) => n + 1)}
        onTranscriptionChange={(transcription) => setCatalog((current) => ({ ...current, transcription }))}
        onPackageChange={(id, status) => setCatalog((current) => current.packages ? {
          ...current, packages: { ...current.packages, [id]: status },
        } : current)} />
    </LanProvider>
  );
}

function AppContent({ catalog, catalogError, onCatalogRetry, nearbyEnabled, onTranscriptionChange, onPackageChange }: {
  catalog: CatalogState;
  catalogError: boolean;
  onCatalogRetry: () => void;
  nearbyEnabled: boolean;
  onTranscriptionChange: (installed: boolean) => void;
  onPackageChange: (id: AddonPackageId, status: AddonPackageStatus) => void;
}) {
  const { hasActive } = useDownloads();
  const { t } = useI18n();
  const { room, roomMinimized, setRoomMinimized, stopNetwork, networkBusy } = useLan();
  const [tab, setTab] = useState<TabId>(() => IS_ANDROID && localStorage.getItem(RESUME_ADDONS) ? "addons" : "downloader");
  const [playing, setPlaying] = useState<VideoRow | null>(null);
  const [playQueue, setPlayQueue] = useState<VideoRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storageVersion, setStorageVersion] = useState(0);
  const [closePrompt, setClosePrompt] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [transcriptionFile, setTranscriptionFile] = useState<VideoRow | null>();
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  useEffect(() => { if (IS_ANDROID) localStorage.removeItem(RESUME_ADDONS); }, []);
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
  const backState = useRef({ playing, settingsOpen, tab, room, roomMinimized, setRoomMinimized });
  backState.current = { playing, settingsOpen, tab, room, roomMinimized, setRoomMinimized };
  useEffect(() => {
    if (!IS_ANDROID) return;
    const sub = onBackButtonPress(() => {
      // Сначала даём плееру выйти из полноэкранного режима (он отменяет событие).
      const ev = new Event("mestia:back", { cancelable: true });
      if (!window.dispatchEvent(ev)) return;
      const s = backState.current;
      // Комнату «Назад» сворачивает, а не закрывает: воспроизведение у всех продолжается.
      if (s.room && !s.roomMinimized) s.setRoomMinimized(true);
      else if (s.playing) setPlaying(null);
      else if (s.settingsOpen) setSettingsOpen(false);
      else if (s.tab !== "downloader") setTab("downloader");
      else moveAppToBack().catch(() => {});
    });
    return () => {
      sub.then((l) => l.unregister()).catch(() => {});
    };
  }, []);

  // Палитра команд: Ctrl+K / ⌘K (на телефоне клавиатурных сочетаний нет).
  useEffect(() => {
    if (IS_ANDROID) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.key === "л" || e.key === "Л")) {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Ссылка из палитры — в Загрузчик, как из «Поделиться». */
  function openLink(text: string) {
    setPlaying(null);
    setSettingsOpen(false);
    setTab("downloader");
    setShared((s) => ({ text, n: (s?.n ?? 0) + 1 }));
  }

  function hideToTray() {
    getCurrentWindow().hide().catch(() => {});
  }

  function openPlayer(video: VideoRow, queue?: VideoRow[]) {
    setPlayQueue(queue ?? [video]);
    setPlaying(video);
  }

  function openTranscription(file: VideoRow | null = null) {
    setTranscriptionFile(file);
    setTab("transcription");
  }

  function changeTab(next: TabId) {
    if (next === "transcription") openTranscription();
    else setTab(next);
  }

  async function installPackage(id: AddonPackageId, onProgress: (bytes: number) => void) {
    if (IS_ANDROID) localStorage.setItem(RESUME_ADDONS, "1");
    try {
      onPackageChange(id, await installAddonPackage(id, onProgress));
    } finally {
      if (IS_ANDROID) localStorage.removeItem(RESUME_ADDONS);
    }
  }

  async function removePackage(id: AddonPackageId) {
    if (id === "nearby" && catalog.packages?.nearby.installed) await stopNetwork();
    if (IS_ANDROID) localStorage.setItem(RESUME_ADDONS, "1");
    try {
      await uninstallAddonPackage(id);
    } finally {
      if (IS_ANDROID) localStorage.removeItem(RESUME_ADDONS);
    }
    onPackageChange(id, { installed: false, present: false, bytes: 0 });
    if (id === "nearby") setTab((current) => current === "nearby" ? "addons" : current);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-snow text-ink">
      <Sidebar
        active={tab === "transcription" ? "addons" : tab}
        showNearby={nearbyEnabled}
        onChange={changeTab}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => setCmdOpen(true)}
        onHideToTray={hideToTray}
      />

      <main className="relative flex flex-1 flex-col overflow-y-auto pb-16 md:pb-0">
        {tab === "downloader" && <Downloader onOpenSettings={() => setSettingsOpen(true)} incoming={shared} />}
        {tab === "locker" && (
          <Locker key={storageVersion} onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")}
            tagsEnabled={catalog.packages?.tags.installed ?? (catalog.transcription === null)} canSendNearby={nearbyEnabled}
            onTranscribe={catalog.transcription === undefined || catalog.transcription === false ? undefined : openTranscription} />
        )}
        {tab === "history" && <History onPlay={openPlayer} onGoToDownloader={() => setTab("downloader")} />}
        {tab === "nearby" && nearbyEnabled && <Nearby />}
        <div hidden={tab !== "addons"}>
          <Addons active={tab === "addons"} installed={catalog.transcription} packages={catalog.packages} nearbyBusy={networkBusy}
            downloadsBusy={hasActive}
            loadError={catalogError} onRetry={onCatalogRetry}
            transcriptionBusy={transcriptionBusy} onOpen={openTranscription}
            onPackageInstall={installPackage} onPackageRemove={removePackage} onPackageOpen={(id) => setTab(id === "nearby" ? "nearby" : "locker")}
            onInstalledChange={(installed) => {
              onTranscriptionChange(installed);
              if (!installed) {
                setTranscriptionFile(undefined);
                setTab((current) => current === "transcription" ? "addons" : current);
              }
            }} />
        </div>
        {/* Сохраняем процесс, журнал и текст при переключении вкладок. */}
        {transcriptionFile !== undefined && (
          <div hidden={tab !== "transcription"}>
            <Transcription file={transcriptionFile} busy={transcriptionBusy} onBusyChange={setTranscriptionBusy} />
          </div>
        )}
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

      {!IS_ANDROID && (
        <CommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          onTab={(tb) => {
            setPlaying(null);
            changeTab(tb);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onPlay={(v) => openPlayer(v)}
          onLink={openLink}
          showNearby={nearbyEnabled}
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
