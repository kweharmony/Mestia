import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import App from "./App";
import "./index.css";
import { ThemeProvider } from "./context/ThemeContext";
import { LanguageProvider } from "./context/LanguageContext";
import { ToastProvider } from "./components/Toast";
import { DragProvider } from "./context/DragContext";
import { DownloadsProvider } from "./context/DownloadsContext";
import { LanProvider } from "./context/LanContext";
import MiniPlayer from "./views/MiniPlayer";

// Отдельное окно плеера: index.html?mini=<id> — рендерим только проигрыватель.
const miniId = new URLSearchParams(window.location.search).get("mini");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* reducedMotion="user" — все motion-анимации уважают системную настройку */}
    <MotionConfig reducedMotion="user">
      <LanguageProvider>
        <ThemeProvider>
          {miniId ? (
            <MiniPlayer id={Number(miniId)} />
          ) : (
            <ToastProvider>
              <DownloadsProvider>
                <LanProvider>
                  <DragProvider>
                    <App />
                  </DragProvider>
                </LanProvider>
              </DownloadsProvider>
            </ToastProvider>
          )}
        </ThemeProvider>
      </LanguageProvider>
    </MotionConfig>
  </React.StrictMode>
);
