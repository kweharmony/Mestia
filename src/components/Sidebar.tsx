import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Download,
  Folders,
  History as HistoryIcon,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Search,
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
  onOpenSearch: () => void;
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
  { id: "nearby", labelKey: "nav.nearby", icon: Radar, anim: "mestia-ico-history" },
];

const COLLAPSED_KEY = "mestia.sidebarCollapsed";

export default function Sidebar({
  active,
  onChange,
  onOpenSettings,
  onOpenSearch,
  onHideToTray,
}: SidebarProps) {
  const { t } = useI18n();
  const { downloads } = useDownloads();
  // Свёрнутая панель (только иконки) — удобство конкретного окна, храним локально.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* хранилище недоступно — состояние живёт до перезапуска */
      }
      return !c;
    });
  }
  // Счётчик активных загрузок — бейдж на пункте «Загрузчик», виден без открытия панели.
  const activeCount = downloads.filter(
    (d) => d.status === "downloading" || d.status === "queued"
  ).length;
  return (
    <>
    {/* Узкий экран (телефон): нижняя панель вкладок вместо боковой. Как Expandable
        Tabs: у активной вкладки — плашка с подписью, остальные только иконками. */}
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around gap-1 border-t-2 border-fog bg-paper px-2 py-2 no-select md:hidden">
      {[...NAV.map((n) => ({ ...n, onClick: () => onChange(n.id) })), {
        id: "settings" as const,
        labelKey: "sidebar.settings",
        icon: Settings,
        anim: "",
        onClick: onOpenSettings,
      }].map(({ id, labelKey, icon: Icon, onClick }) => {
        const on = active === id;
        return (
          <motion.button
            key={id}
            layout
            onClick={onClick}
            aria-label={t(labelKey)}
            aria-current={on ? "page" : undefined}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
            className={`mestia-anim relative flex h-10 items-center justify-center rounded-full px-3 text-[13px] font-semibold ${
              on ? "text-accent" : "text-smoke"
            }`}
          >
            {on && (
              <motion.span
                layoutId="mobile-nav-pill"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
                className="mestia-anim absolute inset-0 rounded-full bg-accent/12"
              />
            )}
            <Icon className="relative h-5 w-5 shrink-0" strokeWidth={2.25} />
            <AnimatePresence initial={false}>
              {on && (
                <motion.span
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: "auto", opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="mestia-anim relative overflow-hidden whitespace-nowrap"
                >
                  <span className="pl-1.5">{t(labelKey)}</span>
                </motion.span>
              )}
            </AnimatePresence>
            {id === "downloader" && activeCount > 0 && (
              <span className="absolute right-0.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                {activeCount}
              </span>
            )}
          </motion.button>
        );
      })}
    </nav>

    <aside
      className={`hidden shrink-0 flex-col justify-between overflow-hidden bg-paper no-select transition-[width] duration-200 ease-out md:flex ${
        collapsed ? "w-[72px]" : "w-[260px]"
      }`}
    >
      <div className="space-y-6 p-4">
        {/* Логотип + сворачивание панели */}
        <div className={`flex items-center ${collapsed ? "flex-col gap-3" : "justify-between"}`}>
          <Logo compact={collapsed} />
          <button
            onClick={toggleCollapsed}
            title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            className="rounded-ui p-1.5 text-smoke transition-colors hover:bg-fog hover:text-ink"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" strokeWidth={2.25} />
            ) : (
              <PanelLeftClose className="h-4 w-4" strokeWidth={2.25} />
            )}
          </button>
        </div>

        {/* Палитра команд (Ctrl+K); на Android её нет */}
        {!IS_ANDROID && <button
          onClick={onOpenSearch}
          title={collapsed ? `${t("sidebar.search")} (Ctrl+K)` : undefined}
          aria-label={t("sidebar.search")}
          className={`flex w-full items-center gap-3 rounded-ui border-2 border-fog py-2 text-sm text-smoke transition-colors hover:border-ink/30 hover:text-ink ${
            collapsed ? "justify-center px-0" : "px-3"
          }`}
        >
          <Search className="h-4 w-4 shrink-0" strokeWidth={2.25} />
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-left font-semibold">{t("sidebar.search")}</span>
              <kbd className="shrink-0 rounded border-2 border-fog px-1 text-[10px] font-bold">Ctrl K</kbd>
            </>
          )}
        </button>}

        {/* Навигация */}
        <nav className="space-y-1">
          {NAV.map(({ id, labelKey, icon: Icon, anim }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                onClick={() => onChange(id)}
                title={collapsed ? t(labelKey) : undefined}
                className={`mestia-nav relative flex w-full items-center gap-3 rounded-ui py-2.5 text-sm transition-all ${
                  collapsed ? "justify-center px-0" : "px-3"
                } ${
                  isActive
                    ? "bg-fog font-semibold opacity-100"
                    : "opacity-80 hover:bg-fog hover:opacity-100"
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${anim}`} strokeWidth={2.25} />
                {!collapsed && <span className="flex-1 truncate text-left">{t(labelKey)}</span>}
                {id === "downloader" && activeCount > 0 && (
                  <span
                    className={`flex items-center justify-center rounded-full bg-accent font-bold text-white ${
                      collapsed
                        ? "absolute right-1.5 top-1 h-4 min-w-4 px-1 text-[9px]"
                        : "h-5 min-w-5 px-1.5 text-[10px]"
                    }`}
                  >
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
          className={`mestia-nav flex w-full items-center gap-3 rounded-ui py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100 ${
            collapsed ? "justify-center px-0" : "px-3"
          }`}
        >
          <Minus className="mestia-ico-folderplus h-4 w-4 shrink-0" strokeWidth={2.25} />
          {!collapsed && <span className="truncate">{t("sidebar.tray")}</span>}
        </button>}
        <button
          onClick={onOpenSettings}
          title={collapsed ? t("sidebar.settings") : undefined}
          className={`mestia-nav flex w-full items-center gap-3 rounded-ui py-2 text-sm opacity-80 transition-all hover:bg-fog hover:opacity-100 ${
            collapsed ? "justify-center px-0" : "px-3"
          }`}
        >
          <Settings className="mestia-ico-gear h-4 w-4 shrink-0" strokeWidth={2.25} />
          {!collapsed && <span className="truncate">{t("sidebar.settings")}</span>}
        </button>
      </div>
    </aside>
    </>
  );
}
