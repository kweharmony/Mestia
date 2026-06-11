import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ThemeName } from "../types";
import { getSetting, setSetting } from "../lib/ipc";

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
}

const STORAGE_KEY = "mestia.theme";

const VALID: ThemeName[] = [
  "lavender",
  "midnight",
  "matcha",
  "mono",
  "ember",
  "indigo",
  "forest",
  "graphite",
];

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // localStorage — для мгновенной отрисовки без мигания при старте.
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    return saved && VALID.includes(saved) ? saved : "lavender";
  });

  // Файл настроек (Rust) — надёжное хранилище, переживающее перезапуск.
  const loadedFromDisk = useRef(false);
  useEffect(() => {
    getSetting("theme")
      .then((saved) => {
        if (saved && VALID.includes(saved as ThemeName)) {
          setThemeState(saved as ThemeName);
        } else {
          // на диске пусто — сохраняем текущее значение
          setSetting("theme", theme).catch(() => {});
        }
        loadedFromDisk.current = true;
      })
      .catch(() => {
        loadedFromDisk.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
    // Пишем в файл настроек только после первичной загрузки с диска,
    // чтобы не перезаписать сохранённое значение значением по умолчанию.
    if (loadedFromDisk.current) {
      setSetting("theme", theme).catch(() => {});
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme должен использоваться внутри ThemeProvider");
  return ctx;
}
