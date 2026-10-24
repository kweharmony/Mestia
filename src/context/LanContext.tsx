import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Inbox, X } from "lucide-react";
import Modal from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "./LanguageContext";
import { useDownloads } from "./DownloadsContext";
import {
  formatBytes,
  getSetting,
  humanizeError,
  isAudioPath,
  lanAnswerOffer,
  lanInfo,
  lanPeers,
  lanRoomJoin,
  lanRoomLeave,
  lanRoomStart,
  lanRoomStop,
  lanStart,
  lanStop,
  setSetting,
  type LanInfo,
  type LanOffer,
  type LanPeer,
  type LanProgress,
} from "../lib/ipc";
import type { VideoRow } from "../types";

/** Открытая комната: ведём сами (video — первый файл очереди) или смотрим чужую. */
export type LanRoom =
  | { role: "host"; video: VideoRow }
  | { role: "guest"; host: string; title: string; kind: "video" | "audio" };

interface LanValue {
  info: LanInfo | null;
  peers: LanPeer[];
  transfers: LanProgress[];
  room: LanRoom | null;
  setVisible: (on: boolean) => Promise<void>;
  rename: (name: string) => Promise<void>;
  clearTransfers: () => void;
  hostRoom: (video: VideoRow) => Promise<void>;
  joinRoom: (peer: LanPeer) => Promise<void>;
  closeRoom: () => void;
}

const LanContext = createContext<LanValue | null>(null);

export function useLan(): LanValue {
  const v = useContext(LanContext);
  if (!v) throw new Error("useLan вне LanProvider");
  return v;
}

/**
 * Локальная сеть: видимость устройства, найденные устройства, передачи файлов,
 * входящие предложения (модалка здесь — чтобы появлялась на любой вкладке) и комната.
 */
export function LanProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { notify } = useToast();
  const { bumpLibrary } = useDownloads();
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [peers, setPeers] = useState<LanPeer[]>([]);
  const [transfers, setTransfers] = useState<LanProgress[]>([]);
  const [offers, setOffers] = useState<LanOffer[]>([]);
  const [room, setRoom] = useState<LanRoom | null>(null);

  useEffect(() => {
    const subs = [
      listen<LanPeer[]>("lan://peers", (e) => setPeers(e.payload)),
      listen<LanOffer>("lan://offer", (e) => setOffers((o) => [...o, e.payload])),
      listen<string>("lan://offer-closed", (e) => setOffers((o) => o.filter((x) => x.id !== e.payload))),
      listen<LanProgress>("lan://progress", (e) =>
        setTransfers((list) => {
          const i = list.findIndex((x) => x.id === e.payload.id);
          if (i < 0) return [e.payload, ...list].slice(0, 50);
          const next = list.slice();
          next[i] = e.payload;
          return next;
        })
      ),
      listen<{ name: string; from: string }>("lan://received", (e) => {
        notify(t("lan.received", { name: e.payload.name, from: e.payload.from }));
        bumpLibrary();
      }),
    ];
    // Видимость включена в прошлый раз — включаем снова при запуске.
    lanInfo().then(setInfo).catch(() => {});
    getSetting("lanVisible")
      .then((v) => (v === "1" ? lanStart().then(setInfo) : undefined))
      .catch(() => {});
    lanPeers().then(setPeers).catch(() => {});
    return () => subs.forEach((s) => s.then((u) => u()));
  }, [t, notify, bumpLibrary]);

  const setVisible = useCallback(
    async (on: boolean) => {
      try {
        if (on) setInfo(await lanStart());
        else {
          await lanStop();
          setInfo(await lanInfo());
        }
        await setSetting("lanVisible", on ? "1" : "0");
      } catch (e) {
        notify(humanizeError(e), "error");
      }
    },
    [notify]
  );

  const rename = useCallback(async (name: string) => {
    await setSetting("lanName", name.trim()).catch(() => {});
    setInfo(await lanInfo());
  }, []);

  const hostRoom = useCallback(
    async (video: VideoRow) => {
      try {
        if (!info?.running) setInfo(await lanStart());
        await lanRoomStart(video.file_path, video.title, isAudioPath(video.file_path) ? "audio" : "video");
        setRoom({ role: "host", video });
      } catch (e) {
        notify(humanizeError(e), "error");
      }
    },
    [info, notify]
  );

  const joinRoom = useCallback(
    async (peer: LanPeer) => {
      try {
        const j = await lanRoomJoin(peer.addr);
        setRoom({ role: "guest", host: peer.name, ...j });
      } catch (e) {
        notify(humanizeError(e), "error");
      }
    },
    [notify]
  );

  const closeRoom = useCallback(() => {
    setRoom((r) => {
      if (r?.role === "host") lanRoomStop().catch(() => {});
      if (r?.role === "guest") lanRoomLeave().catch(() => {});
      return null;
    });
  }, []);

  const offer = offers[0] ?? null;
  function answer(accept: boolean) {
    if (!offer) return;
    lanAnswerOffer(offer.id, accept).catch(() => {});
    setOffers((o) => o.slice(1));
  }

  return (
    <LanContext.Provider
      value={{
        info,
        peers,
        transfers,
        room,
        setVisible,
        rename,
        clearTransfers: () => setTransfers((l) => l.filter((x) => !x.error && x.done < x.total)),
        hostRoom,
        joinRoom,
        closeRoom,
      }}
    >
      {children}

      {/* Входящие файлы: принять / отклонить */}
      <Modal open={!!offer} z={70}>
        {offer && (
          <>
            <div className="flex items-center gap-2">
              <Inbox className="h-5 w-5 shrink-0 text-accent" strokeWidth={2.25} />
              <h3 className="text-base font-semibold tracking-tight">
                {t("lan.offerTitle", { from: offer.from })}
              </h3>
            </div>
            <p className="text-sm font-semibold text-smoke">
              {t("lan.offerText", { n: offer.files.length, size: formatBytes(offer.total) })}
            </p>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-ui border-2 border-fog bg-paper/40 p-2 text-xs font-semibold">
              {offer.files.map((f) => (
                <li key={f.id} className="flex justify-between gap-2">
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-smoke">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => answer(false)}
                className="flex items-center gap-2 rounded-ui border-2 border-fog px-4 py-2 text-sm font-semibold hover:bg-fog"
              >
                <X className="h-4 w-4" strokeWidth={2.25} />
                {t("lan.decline")}
              </button>
              <button
                onClick={() => answer(true)}
                className="flex items-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <Check className="h-4 w-4" strokeWidth={2.25} />
                {t("lan.accept")}
              </button>
            </div>
          </>
        )}
      </Modal>
    </LanContext.Provider>
  );
}
