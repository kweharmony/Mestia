import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ClipboardPaste,
  CornerDownLeft,
  Download,
  Folders,
  History as HistoryIcon,
  Link2,
  Music,
  Radar,
  Search,
  Settings,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { TabId, ThemeName, VideoRow } from "../types";
import { searchVideos } from "../lib/db";
import { isAudioPath } from "../lib/ipc";
import { extractUrl } from "../lib/platform";
import { useI18n } from "../context/LanguageContext";
import { useTheme } from "../context/ThemeContext";
import { THEMES } from "./ThemeSwitcher";

interface Item {
  id: string;
  group: "link" | "actions" | "files" | "themes";
  label: string;
  hint?: string;
  icon?: LucideIcon;
  color?: string; // кружок темы вместо иконки
  run: () => void;
}

/**
 * Палитра команд (Ctrl+K / ⌘K, компьютер): вставить ссылку, перейти в раздел,
 * найти файл в медиатеке, сменить тему, открыть настройки. Стрелки + Enter.
 */
export default function CommandPalette({
  open,
  onClose,
  onTab,
  onOpenSettings,
  onPlay,
  onLink,
}: {
  open: boolean;
  onClose: () => void;
  onTab: (tab: TabId) => void;
  onOpenSettings: () => void;
  onPlay: (v: VideoRow) => void;
  onLink: (text: string) => void;
}) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<VideoRow[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Поиск по медиатеке — с небольшой задержкой, чтобы не дёргать БД на каждую букву.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) return setFiles([]);
    let alive = true;
    const h = window.setTimeout(() => {
      searchVideos(q)
        .then((r) => alive && setFiles(r.slice(0, 8)))
        .catch(() => alive && setFiles([]));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [query, open]);

  const items = useMemo<Item[]>(() => {
    const done = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Item[] = [];

    // Вставили ссылку прямо в строку поиска — первым пунктом «Скачать».
    const url = extractUrl(query);
    if (url) out.push({ id: "dl-url", group: "link", label: t("cmd.download"), hint: url, icon: Link2, run: done(() => onLink(url)) });

    const actions: Item[] = [
      {
        id: "paste",
        group: "actions",
        label: t("cmd.paste"),
        icon: ClipboardPaste,
        run: done(() => {
          readText()
            .then((txt) => txt?.trim() && onLink(txt.trim()))
            .catch(() => {});
        }),
      },
      { id: "tab-downloader", group: "actions", label: t("nav.downloader"), icon: Download, run: done(() => onTab("downloader")) },
      { id: "tab-locker", group: "actions", label: t("nav.locker"), icon: Folders, run: done(() => onTab("locker")) },
      { id: "tab-history", group: "actions", label: t("nav.history"), icon: HistoryIcon, run: done(() => onTab("history")) },
      { id: "tab-nearby", group: "actions", label: t("nav.nearby"), icon: Radar, run: done(() => onTab("nearby")) },
      { id: "settings", group: "actions", label: t("sidebar.settings"), icon: Settings, run: done(onOpenSettings) },
    ];
    out.push(...actions.filter((a) => match(a.label)));

    for (const v of files) {
      out.push({
        id: `file-${v.id}`,
        group: "files",
        label: v.title,
        hint: v.platform ?? undefined,
        icon: isAudioPath(v.file_path) ? Music : Video,
        run: done(() => onPlay(v)),
      });
    }

    const themeWord = t("set.theme").toLowerCase();
    for (const th of THEMES) {
      if (!q || match(th.label) || themeWord.includes(q) || q.includes(themeWord)) {
        out.push({
          id: `theme-${th.name}`,
          group: "themes",
          label: th.label,
          hint: th.name === theme ? t("cmd.current") : t(th.kindKey),
          color: th.color,
          run: () => setTheme(th.name as ThemeName), // палитра не закрывается — можно перебрать темы
        });
      }
    }
    return out;
  }, [query, files, theme, t, onClose, onLink, onTab, onOpenSettings, onPlay, setTheme]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[sel]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const groupTitle: Record<Item["group"], string> = {
    link: t("cmd.groupLink"),
    actions: t("cmd.groupActions"),
    files: t("cmd.groupFiles"),
    themes: t("cmd.groupThemes"),
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="mestia-anim fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            className="mestia-anim flex max-h-[70vh] w-full max-w-[560px] flex-col overflow-hidden rounded-ui border-2 border-ink bg-snow shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("cmd.title")}
          >
            <div className="flex items-center gap-3 border-b-2 border-fog px-4">
              <Search className="h-4 w-4 shrink-0 text-smoke" strokeWidth={2.25} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder={t("cmd.placeholder")}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:text-smoke"
                role="combobox"
                aria-expanded="true"
                aria-controls="cmd-list"
              />
              <kbd className="shrink-0 rounded border-2 border-fog px-1.5 text-[10px] font-bold text-smoke">Esc</kbd>
            </div>

            <div ref={listRef} id="cmd-list" role="listbox" className="overflow-y-auto p-2">
              {items.length === 0 && (
                <div className="px-3 py-8 text-center text-sm font-semibold text-smoke">{t("cmd.empty")}</div>
              )}
              {items.map((it, i) => (
                <div key={it.id}>
                  {(i === 0 || items[i - 1].group !== it.group) && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-smoke">
                      {groupTitle[it.group]}
                    </div>
                  )}
                  <button
                    data-i={i}
                    role="option"
                    aria-selected={i === sel}
                    onMouseMove={() => setSel(i)}
                    onClick={it.run}
                    className={`flex w-full items-center gap-3 rounded-ui px-3 py-2 text-left text-sm font-semibold ${
                      i === sel ? "bg-fog text-ink" : "text-ink/85"
                    }`}
                  >
                    {it.color ? (
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-ink/10" style={{ backgroundColor: it.color }} />
                    ) : it.icon ? (
                      <it.icon className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.25} />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="max-w-[45%] shrink-0 truncate text-xs text-smoke">{it.hint}</span>}
                    {i === sel && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-smoke" strokeWidth={2.25} />}
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
