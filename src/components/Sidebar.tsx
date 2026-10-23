import {
  Download,
  Folders,
  History as HistoryIcon,
  Minus,
  Settings,
} from "lucide-react";
import type { TabId } from "../types";
import { useDownloads } from "../context/DownloadsContext";
import { useI18n } from "../context/LanguageContext";
import Logo from "./Logo";
import { IS_ANDROID } from "../lib/platform";

interface SidebarProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  onOpenSettings: () => void;
  onHideToTray: () => void;
}

interface NavDef {
  id: TabId;
  labelKey: string;
  icon: typeof Download;
  anim: string; // класс анимации иконки при наведении
}

const NAV: NavDef[] = [
  { id: "downloader", labelKey: "nav.downloader", icon: Download, anim: "mestia-ico-dl" },
  { id: "locker", labelKey: "nav.locker", icon: Folders, anim: "mestia-ico-folder" },
  { id: "history", labelKey: "nav.history", icon: HistoryIcon, anim: "mestia-ico-history" },
];

export default function Sidebar({
  active,
  onChange,
  onOpenSettings,
  onHideToTray,
}: SidebarProps) {
  const { t } = useI18n();
  const { downloads } = useDownloads();
  // Счётчик активных загрузок — бейдж на пункте «Загрузчик», виден без открытия панели.
  const activeCount = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;
  return (
    <>
    {/* Узкий экран (телефон): нижняя панель вкладок вместо боковой. */}
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t-2 border-fog bg-paper no-select md:hidden">
      {NAV.map(({ id, labelKey, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${
            active === id ? "text-accent" : "text-smoke"
          }`}
        >
          <Icon className="h-5 w-5" strokeWidth={2.25} />
          {t(labelKey)}
          {id === "downloader" && activeCount > 0 && (
            <span className="absolute right-[calc(50%-22px)] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
              {activeCount}
            </span>
          )}
        </button>
      ))}
      <button
        onClick={onOpenSettings}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold text-smoke"
      >
        <Settings className="h-5 w-5" strokeWidth={2.25} />
        {t("sidebar.settings")}
      </button>
    </nav>

    <aside className="hidden w-[260px] shrink-0 flex-col justify-between bg-paper no-select md:flex">
      <div className="space-y-6 p-4">
        {/* Логотип */}
        <Logo />

        {/* Навигация */}
        <nav className="space-y-1">
          {NAV.map(({ id, labelKey, icon: Icon, anim }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                onClick={() => onChange(id)}
                className={`mestia-nav flex w-full items-center gap-3 rounded-ui px-3 py-2.5 text-sm transition-all ${
                  isActive
                    ? "bg-fog font-semibold opacity-100"
                    : "opacity-80 hover:bg-fog hover:opacity-100"
                }`}
              >
                <Icon className={`h-4 w-4 ${anim}`} strokeWidth={2.25} />
                <span className="flex-1 text-left">{t(labelKey)}</span>
                {id === "downloader" && activeCount > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                    {activeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Подвал: мини-режим + настройки */}
      <div className="space-y-1 p-4">
        {/* Трея на Android нет. */}
        {!IS_ANDROID && <button
          onClick={onHideToTray}
          title={t("sidebar.trayTitle")}
          className="mestia-nav flex w-full items-center gap-3 rounded-ui px-3 py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100"
        >
          <Minus className="mestia-ico-folderplus h-4 w-4" strokeWidth={2.25} />
          {t("sidebar.tray")}
        </button>}
        <button
          onClick={onOpenSettings}
          className="mestia-nav flex w-full items-center gap-3 rounded-ui px-3 py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100"
        >
          <Settings className="mestia-ico-gear h-4 w-4" strokeWidth={2.25} />
          {t("sidebar.settings")}
        </button>
      </div>
    </aside>
    </>
  );
}
