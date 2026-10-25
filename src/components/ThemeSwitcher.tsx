import { useTheme } from "../context/ThemeContext";
import { useI18n } from "../context/LanguageContext";
import type { ThemeName } from "../types";
import { LOGO_MARK } from "../lib/appIcon";
import { IS_ANDROID } from "../lib/platform";

interface ThemeDef {
  name: ThemeName;
  label: string; // фирменное название темы (не переводится)
  kindKey: string; // ключ перевода вида темы (светлая/тёмная/…)
  color: string; // акцент темы = плашка иконки приложения (--c-accent в index.css)
}

export const THEMES: ThemeDef[] = [
  // Светлые
  { name: "lavender", label: "Sunset Lavender", kindKey: "theme.light", color: "#de8255" },
  { name: "midnight", label: "Velvet Midnight", kindKey: "theme.light", color: "#ae445d" },
  { name: "matcha", label: "Matcha Oasis", kindKey: "theme.light", color: "#458282" },
  { name: "mono", label: "Clean Mono", kindKey: "theme.neutralLight", color: "#1a1a1a" },
  // Тёмные
  { name: "ember", label: "Warm Ember", kindKey: "theme.dark", color: "#bb6044" },
  { name: "indigo", label: "Midnight Indigo", kindKey: "theme.dark", color: "#5672af" },
  { name: "forest", label: "Deep Forest", kindKey: "theme.dark", color: "#2a5747" },
  { name: "graphite", label: "Graphite", kindKey: "theme.neutralDark", color: "#74736b" },
];

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const current = THEMES.find((th) => th.name === theme) ?? THEMES[0];

  return (
    <div className="space-y-3">
      {/* Каждая тема — плиткой той иконки приложения, что с ней будет */}
      <div className="grid grid-cols-4 gap-3">
        {THEMES.map((th) => {
          const active = theme === th.name;
          return (
            <button
              key={th.name}
              onClick={() => setTheme(th.name)}
              title={`${th.label} (${t(th.kindKey)})`}
              aria-pressed={active}
              className="group flex flex-col items-center gap-2 focus:outline-none"
            >
              <AppIconTile
                color={th.color}
                className={`h-10 w-10 cursor-pointer ring-offset-2 ring-offset-snow transition-all group-hover:scale-110 ${
                  active ? "ring-2 ring-ink" : ""
                }`}
              />
              <div
                className={`h-1.5 w-1.5 rounded-full bg-ink transition-all duration-200 ${
                  active ? "opacity-100" : "opacity-0"
                }`}
              />
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 rounded-ui border-2 border-fog p-2.5">
        <AppIconTile color={current.color} className="h-11 w-11 shrink-0 shadow-sm" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {current.label} <span className="text-smoke">· {t(current.kindKey)}</span>
          </div>
          <div className="text-xs font-semibold text-smoke">
            {t(IS_ANDROID ? "set.iconHintAndroid" : "set.iconHint")}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Иконка приложения в цвете темы: скруглённая плашка + белый знак (как в appIcon.iconSvg). */
function AppIconTile({ color, className = "" }: { color: string; className?: string }) {
  return (
    <span
      className={`flex items-center justify-center rounded-[22%] ${className}`}
      style={{ backgroundColor: color }}
    >
      <svg
        viewBox="0 0 256 256"
        className="h-[82%] w-[82%] text-white"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: LOGO_MARK }}
      />
    </span>
  );
}
