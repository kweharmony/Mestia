import {
  Download,
  Folders,
  History as HistoryIcon,
  Minus,
  Settings,
} from "lucide-react";
import type { TabId } from "../types";
import { useI18n } from "../context/LanguageContext";
import Logo from "./Logo";

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
  return (
    <aside className="flex w-[260px] shrink-0 flex-col justify-between bg-paper no-select">
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
                {t(labelKey)}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Подвал: мини-режим + настройки */}
      <div className="space-y-1 p-4">
        <button
          onClick={onHideToTray}
          title={t("sidebar.trayTitle")}
          className="mestia-nav flex w-full items-center gap-3 rounded-ui px-3 py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100"
        >
          <Minus className="mestia-ico-folderplus h-4 w-4" strokeWidth={2.25} />
          {t("sidebar.tray")}
        </button>
        <button
          onClick={onOpenSettings}
          className="mestia-nav flex w-full items-center gap-3 rounded-ui px-3 py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100"
        >
          <Settings className="mestia-ico-gear h-4 w-4" strokeWidth={2.25} />
          {t("sidebar.settings")}
        </button>
      </div>
    </aside>
  );
}
