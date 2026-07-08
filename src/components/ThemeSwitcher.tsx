import { useTheme } from "../context/ThemeContext";
import { useI18n } from "../context/LanguageContext";
import type { ThemeName } from "../types";

interface ThemeDef {
  name: ThemeName;
  label: string; // фирменное название темы (не переводится)
  kindKey: string; // ключ перевода вида темы (светлая/тёмная/…)
  color: string; // акцентный цвет темы (одноцветный кружок)
}

const THEMES: ThemeDef[] = [
  // Светлые
  { name: "lavender", label: "Sunset Lavender", kindKey: "theme.light", color: "#de8255" },
  { name: "midnight", label: "Velvet Midnight", kindKey: "theme.light", color: "#ae445d" },
  { name: "matcha", label: "Matcha Oasis", kindKey: "theme.light", color: "#458282" },
  { name: "mono", label: "Clean Mono", kindKey: "theme.neutralLight", color: "#1a1a1a" },
  // Тёмные
  { name: "ember", label: "Warm Ember", kindKey: "theme.dark", color: "#bb6044" },
  { name: "indigo", label: "Midnight Indigo", kindKey: "theme.dark", color: "#5672af" },
  { name: "forest", label: "Deep Forest", kindKey: "theme.dark", color: "#2a5747" },
  { name: "graphite", label: "Graphite", kindKey: "theme.neutralDark", color: "#6a6a62" },
];

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-4 gap-3">
      {THEMES.map((th) => {
        const active = theme === th.name;
        return (
          <button
            key={th.name}
            onClick={() => setTheme(th.name)}
            title={`${th.label} (${t(th.kindKey)})`}
            className="group flex flex-col items-center gap-2 focus:outline-none"
          >
            <div
              className={`h-9 w-9 cursor-pointer rounded-full border-2 transition-all group-hover:scale-110 ${
                active ? "border-ink" : "border-transparent"
              }`}
              style={{ backgroundColor: th.color }}
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
  );
}
