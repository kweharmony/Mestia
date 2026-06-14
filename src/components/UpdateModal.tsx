import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, RefreshCw, X } from "lucide-react";
import { updaterSupported } from "../lib/ipc";

type Phase = "prompt" | "downloading" | "error";

/**
 * Проверяет наличие обновления при запуске приложения. Если новая версия есть —
 * показывает окно с вопросом. По согласию скачивает, устанавливает и
 * перезапускает приложение.
 *
 * Рендерится только в главном окне (App), поэтому проверка идёт один раз.
 */
export default function UpdateModal() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [progress, setProgress] = useState(0); // 0..1, -1 — размер неизвестен
  const [error, setError] = useState("");

  // Проверяем обновления один раз при запуске.
  useEffect(() => {
    let cancelled = false;
    // Самообновление есть не везде: Win/macOS — да, Linux — только AppImage
    // (.deb/.rpm/Flatpak обновляются пакетным менеджером). Иначе не проверяем.
    updaterSupported()
      .then((supported) => {
        if (!supported || cancelled) return;
        return check().then((u) => {
          // u === null — версия актуальна. В dev-сборке (без подписи) check бросит
          // ошибку — её глушим в catch, чтобы не мешать разработке.
          if (!cancelled && u) setUpdate(u);
        });
      })
      .catch(() => {
        /* нет сети / dev-сборка / Flatpak / endpoint недоступен — молча игнорируем */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  async function runUpdate() {
    if (!update) return;
    setPhase("downloading");
    setProgress(-1);
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setProgress(total ? 0 : -1);
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total) setProgress(Math.min(1, received / total));
            break;
          case "Finished":
            setProgress(1);
            break;
        }
      });
      // Установка завершена — перезапускаем приложение в новой версии.
      await relaunch();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  const pct = progress < 0 ? null : Math.round(progress * 100);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm">
      <div className="w-full max-w-[420px] space-y-5 rounded-ui border-2 border-ink bg-snow p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-ui bg-accent text-white">
            <RefreshCw className="h-5 w-5" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight">Доступно обновление</h3>
            <p className="mt-1 text-sm font-semibold text-smoke">
              Новая версия <span className="text-ink">v{update.version}</span>
              {update.currentVersion ? (
                <>
                  {" "}
                  (у вас v{update.currentVersion})
                </>
              ) : null}
              . Обновить сейчас?
            </p>
          </div>
        </div>

        {/* Описание изменений из релиза, если есть */}
        {update.body ? (
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-ui border-2 border-fog bg-fog/40 p-3 text-xs font-medium text-smoke">
            {update.body}
          </div>
        ) : null}

        {phase === "error" && (
          <div className="rounded-ui border-2 border-accent/40 bg-accent/10 p-3 text-xs font-semibold text-accent">
            Не удалось установить обновление.
            <span className="mt-1 block break-all font-medium opacity-80">{error}</span>
          </div>
        )}

        {phase === "downloading" ? (
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-fog">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: pct === null ? "100%" : `${pct}%` }}
              />
            </div>
            <p className="text-center text-xs font-semibold text-smoke">
              {pct === null ? "Загрузка обновления…" : `Загрузка… ${pct}%`}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              onClick={runUpdate}
              className="flex items-center justify-center gap-2 rounded-ui bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              <Download className="h-4 w-4" strokeWidth={2.25} />
              {phase === "error" ? "Попробовать снова" : "Обновить и перезапустить"}
            </button>
            <button
              onClick={() => setUpdate(null)}
              className="flex items-center justify-center gap-2 rounded-ui px-4 py-2 text-sm font-semibold text-smoke hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={2.25} />
              Позже
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
