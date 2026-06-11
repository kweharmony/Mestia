import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./components/Toast";
import { DragProvider } from "./context/DragContext";
import { DownloadsProvider } from "./context/DownloadsContext";
import MiniPlayer from "./views/MiniPlayer";

// Отдельное окно плеера: index.html?mini=<id> — рендерим только проигрыватель.
const miniId = new URLSearchParams(window.location.search).get("mini");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      {miniId ? (
        <MiniPlayer id={Number(miniId)} />
      ) : (
        <ToastProvider>
          <DownloadsProvider>
            <DragProvider>
              <App />
            </DragProvider>
          </DownloadsProvider>
        </ToastProvider>
      )}
    </ThemeProvider>
  </React.StrictMode>
);
