import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getSetting, setSetting } from "../lib/ipc";
import {
  detectLang,
  LANGS,
  LANG_STORAGE_KEY,
  setActiveLang,
  translate,
  type Lang,
} from "../lib/i18n";

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Перевод по текущему языку (реактивный — компоненты перерисуются при смене). */
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  // localStorage — для мгновенного языка без мигания при старте; иначе — по ОС.
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null;
    return saved && LANGS.includes(saved) ? saved : detectLang();
  });

  // Файл настроек (Rust) — надёжное хранилище, переживающее перезапуск.
  const loadedFromDisk = useRef(false);
  useEffect(() => {
    getSetting("lang")
      .then((saved) => {
        if (saved && LANGS.includes(saved as Lang)) {
          setLangState(saved as Lang);
        } else {
          // на диске пусто — сохраняем текущее (определённое по ОС) значение
          setSetting("lang", lang).catch(() => {});
        }
        loadedFromDisk.current = true;
      })
      .catch(() => {
        loadedFromDisk.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveLang(lang); // синхронизируем модульный язык (для не-React кода)
    document.documentElement.setAttribute("lang", lang);
    localStorage.setItem(LANG_STORAGE_KEY, lang);
    if (loadedFromDisk.current) {
      setSetting("lang", lang).catch(() => {});
    }
  }, [lang]);

  const t = (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);

  return (
    <LanguageContext.Provider value={{ lang, setLang: setLangState, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useI18n должен использоваться внутри LanguageProvider");
  return ctx;
}
