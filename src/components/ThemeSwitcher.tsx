import { useTheme } from "../context/ThemeContext";
import type { ThemeName } from "../types";

interface ThemeDef {
  name: ThemeName;
  title: string;
  color: string; // акцентный цвет темы (одноцветный кружок)
}

const THEMES: ThemeDef[] = [
  // Светлые
  { name: "lavender", title: "Sunset Lavender (светлая)", color: "#de8255" },
  { name: "midnight", title: "Velvet Midnight (светлая)", color: "#ae445d" },
  { name: "matcha", title: "Matcha Oasis (светлая)", color: "#458282" },
  { name: "mono", title: "Clean Mono (нейтральная светлая)", color: "#1a1a1a" },
  // Тёмные
  { name: "ember", title: "Warm Ember (тёмная)", color: "#bb6044" },
  { name: "indigo", title: "Midnight Indigo (тёмная)", color: "#5672af" },
  { name: "forest", title: "Deep Forest (тёмная)", color: "#2a5747" },
  { name: "graphite", title: "Graphite (нейтральная тёмная)", color: "#6a6a62" },
];

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="grid grid-cols-4 gap-3">
      {THEMES.map((t) => {
        const active = theme === t.name;
        return (
          <button
            key={t.name}
            onClick={() => setTheme(t.name)}
            title={t.title}
            className="group flex flex-col items-center gap-2 focus:outline-none"
          >
            <div
              className={`h-9 w-9 cursor-pointer rounded-full border-2 transition-all group-hover:scale-110 ${
                active ? "border-ink" : "border-transparent"
              }`}
              style={{ backgroundColor: t.color }}
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
