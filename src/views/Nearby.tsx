import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Clapperboard,
  HelpCircle,
  Link2,
  Loader2,
  Monitor,
  Pencil,
  Play,
  Radar,
  Send,
  Smartphone,
  Trash2,
  Tv,
  Wifi,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import LibraryPicker from "../components/LibraryPicker";
import { useToast } from "../components/Toast";
import { useLan } from "../context/LanContext";
import { useI18n } from "../context/LanguageContext";
import { formatBytes, humanizeError, lanProbe, lanSend, type LanPeer } from "../lib/ipc";
import { IS_ANDROID } from "../lib/platform";

/** Адреса для подсказки пользователю: только домашние сети (без VPN/мобильных/Docker). */
function lanAddrs(ips: string[], port: number): string[] {
  const home = ips.filter((ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  // 192.168.* — почти всегда Wi-Fi; его первым.
  home.sort((a, b) => Number(b.startsWith("192.168.")) - Number(a.startsWith("192.168.")));
  return (home.length ? home : ips).slice(0, 2).map((ip) => (port === 53318 ? ip : `${ip}:${port}`));
}

/** Вкладка «Рядом»: устройства с Mestia в той же сети — отправка файлов и совместный просмотр. */
export default function Nearby() {
  const { t } = useI18n();
  const { notify } = useToast();
  const { info, peers, transfers, setVisible, rename, clearTransfers, hostRoom, joinRoom } = useLan();
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [manual, setManual] = useState("");
  const [probing, setProbing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [help, setHelp] = useState(false);
  // Для чего выбираем файлы: отправка устройству или комната.
  const [picker, setPicker] = useState<null | { mode: "send"; peer: LanPeer } | { mode: "room" }>(null);
  const [sending, setSending] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (info) setName(info.name);
  }, [info]);

  const running = !!info?.running;
  const addrs = lanAddrs(info?.ips ?? [], info?.port ?? 53318);

  async function toggle() {
    setToggling(true);
    await setVisible(!running);
    setToggling(false);
  }

  function saveName() {
    setEditingName(false);
    if (name.trim() && name.trim() !== info?.name) void rename(name);
    else if (info) setName(info.name);
  }

  async function connect() {
    if (!manual.trim()) return;
    setProbing(true);
    try {
      const p = await lanProbe(manual);
      notify(t("lan.found", { name: p.name }));
      setManual("");
    } catch (e) {
      notify(humanizeError(e), "error");
    } finally {
      setProbing(false);
    }
  }

  async function send(peer: LanPeer, paths: string[]) {
    if (!paths.length) return;
    setSending((s) => new Set(s).add(peer.id));
    notify(t("lan.waitingAnswer", { name: peer.name }));
    try {
      await lanSend(peer.addr, peer.name, paths);
      notify(t("lan.sent", { name: peer.name }));
    } catch (e) {
      notify(humanizeError(e), "error");
    } finally {
      setSending((s) => {
        const n = new Set(s);
        n.delete(peer.id);
        return n;
      });
    }
  }

  async function pickFromDisk(peer: LanPeer) {
    setPicker(null);
    const picked = await openDialog({ multiple: true, directory: false }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    void send(peer, paths);
  }

  return (
    <div className="mestia-fade-in flex-1 p-4 md:p-12">
      <div className="mx-auto max-w-[1000px] space-y-8">
        <div className="border-b-2 border-fog pb-4">
          <h1 className="text-2xl font-normal tracking-tight">{t("lan.title")}</h1>
          <p className="mt-1 text-sm font-semibold text-smoke">{t("lan.subtitle")}</p>
        </div>

        {!running ? (
          /* Выключено: что это и как начать */
          <section className="space-y-6 rounded-ui border-2 border-fog bg-paper/30 p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Radar className="h-6 w-6" strokeWidth={2.25} />
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight">{t("lan.introTitle")}</h2>
                <p className="mt-1 text-sm font-semibold text-smoke">{t("lan.introText")}</p>
              </div>
            </div>
            <ol className="grid gap-3 sm:grid-cols-3">
              {[t("lan.step1"), t("lan.step2"), t("lan.step3")].map((s, i) => (
                <li key={i} className="flex gap-3 rounded-ui border-2 border-fog bg-snow p-3 text-sm font-semibold">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
            <button
              onClick={toggle}
              disabled={toggling}
              className="flex w-full items-center justify-center gap-2 rounded-ui bg-accent px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50 sm:w-auto"
            >
              {toggling ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} /> : <Wifi className="h-4 w-4" strokeWidth={2.25} />}
              {t("lan.turnOn")}
            </button>
          </section>
        ) : (
          <>
            {/* Включено: как нас видят другие */}
            <section className="flex flex-col gap-3 rounded-ui border-2 border-fog bg-paper/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="relative flex h-3 w-3 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
                {editingName ? (
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={saveName}
                    onKeyDown={(e) => e.key === "Enter" && saveName()}
                    className="min-w-0 flex-1 rounded-ui border-2 border-accent bg-snow px-2 py-1 text-sm font-semibold text-ink outline-none"
                  />
                ) : (
                  <p className="min-w-0 text-sm font-semibold">
                    {t("lan.youAre")} <span className="text-accent">«{info?.name}»</span>
                    <button
                      onClick={() => setEditingName(true)}
                      title={t("lan.rename")}
                      className="ml-1.5 inline-flex rounded-ui p-1 align-middle text-smoke hover:bg-fog hover:text-ink"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </button>
                  </p>
                )}
              </div>
              <button
                onClick={toggle}
                disabled={toggling}
                className="shrink-0 rounded-ui border-2 border-fog px-3 py-1.5 text-xs font-semibold text-smoke hover:bg-fog hover:text-ink disabled:opacity-50"
              >
                {t("lan.turnOff")}
              </button>
            </section>

            {/* Устройства */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">{t("lan.devices")}</h2>
              {peers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-ui border-2 border-dashed border-fog px-4 py-10 text-center">
                  <span className="relative flex h-12 w-12 items-center justify-center text-accent">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/20 motion-reduce:hidden" />
                    <Radar className="relative h-6 w-6" strokeWidth={2.25} />
                  </span>
                  <p className="text-sm font-semibold">{t("lan.searchingTitle")}</p>
                  <p className="max-w-[420px] text-xs font-semibold text-smoke">{t("lan.searchingText")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {peers.map((p) => {
                    const Icon = p.platform === "android" ? Smartphone : Monitor;
                    const busy = sending.has(p.id);
                    return (
                      <div key={p.id} className="space-y-3 rounded-ui border-2 border-fog bg-paper/30 p-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                            <Icon className="h-5 w-5" strokeWidth={2.25} />
                          </div>
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold">{p.name}</h4>
                            <p className="truncate text-xs font-semibold text-smoke">
                              {p.room ? t("lan.roomOpen", { title: p.room }) : t("lan.ready")}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          {p.room && (
                            <button
                              onClick={() => joinRoom(p)}
                              className="flex flex-1 items-center justify-center gap-2 rounded-ui bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
                            >
                              <Tv className="h-4 w-4" strokeWidth={2.25} />
                              {t("lan.join")}
                            </button>
                          )}
                          <button
                            onClick={() => setPicker({ mode: "send", peer: p })}
                            disabled={busy}
                            className="flex flex-1 items-center justify-center gap-2 rounded-ui border-2 border-ink px-3 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} /> : <Send className="h-4 w-4" strokeWidth={2.25} />}
                            {busy ? t("lan.sending") : t("lan.sendFiles")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {/* Совместный просмотр */}
        <section className="flex flex-col gap-4 rounded-ui border-2 border-fog bg-paper/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Clapperboard className="mt-0.5 h-5 w-5 shrink-0 text-accent" strokeWidth={2.25} />
            <div>
              <h2 className="text-sm font-semibold">{t("lan.together")}</h2>
              <p className="mt-0.5 text-xs font-semibold text-smoke">{t("lan.togetherHint")}</p>
            </div>
          </div>
          <button
            onClick={() => setPicker({ mode: "room" })}
            className="flex shrink-0 items-center justify-center gap-2 rounded-ui bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Play className="h-4 w-4" strokeWidth={2.25} />
            {t("lan.createRoom")}
          </button>
        </section>

        {/* Передачи */}
        {transfers.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("lan.transfers")}</h2>
              <button
                onClick={clearTransfers}
                className="flex items-center gap-1.5 text-xs font-semibold text-smoke hover:text-ink"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                {t("lan.clearDone")}
              </button>
            </div>
            <div className="space-y-2">
              {transfers.map((x) => {
                const pct = x.total ? Math.round((x.done / x.total) * 100) : 100;
                const done = !x.error && pct >= 100;
                const Dir = x.error ? AlertCircle : done ? Check : x.dir === "in" ? ArrowDownToLine : ArrowUpFromLine;
                return (
                  <div key={x.id} className="space-y-1.5 rounded-ui border-2 border-fog p-3">
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                      <span className="flex min-w-0 items-center gap-2">
                        <Dir className={`h-4 w-4 shrink-0 ${x.error ? "text-rose-500" : done ? "text-emerald-500" : "text-accent"}`} strokeWidth={2.25} />
                        <span className="truncate">{x.name}</span>
                      </span>
                      <span className="shrink-0 text-smoke">
                        {x.error ? t("lan.failed") : done ? formatBytes(x.total) : `${pct}%`}
                      </span>
                    </div>
                    {!done && (
                      <div className="h-1.5 overflow-hidden rounded-full bg-fog">
                        <div
                          className={`h-full transition-[width] duration-200 ${x.error ? "bg-rose-500" : "bg-accent"}`}
                          style={{ width: `${x.error ? 100 : pct}%` }}
                        />
                      </div>
                    )}
                    <p className="text-[11px] font-semibold text-smoke">
                      {x.dir === "in"
                        ? done
                          ? t("lan.receivedFrom", { name: x.peer })
                          : t("lan.fromPeer", { name: x.peer })
                        : done
                          ? t("lan.sentTo", { name: x.peer })
                          : t("lan.toPeer", { name: x.peer })}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Помощь: не находится устройство */}
        {running && (
          <section className="rounded-ui border-2 border-fog">
            <button
              onClick={() => setHelp((h) => !h)}
              aria-expanded={help}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-semibold"
            >
              <span className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-accent" strokeWidth={2.25} />
                {t("lan.helpTitle")}
              </span>
              <motion.span animate={{ rotate: help ? 180 : 0 }} transition={{ duration: 0.2 }} className="mestia-anim text-smoke">
                <ChevronDown className="h-4 w-4" strokeWidth={2.25} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {help && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="mestia-anim overflow-hidden"
                >
                  <div className="space-y-4 px-4 pb-4">
                    <ul className="list-disc space-y-1.5 pl-5 text-xs font-semibold text-smoke">
                      <li>{t("lan.tipSameWifi")}</li>
                      <li>{t("lan.tipBothOn")}</li>
                      {!IS_ANDROID && <li>{t("lan.tipFirewall")}</li>}
                      <li>{t("lan.tipGuest")}</li>
                    </ul>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold">
                        {t("lan.myAddress")} <span className="text-accent">{addrs.join(", ") || "—"}</span>
                      </p>
                      <p className="text-xs font-semibold text-smoke">{t("lan.manualHint")}</p>
                      <div className="flex gap-2">
                        <input
                          value={manual}
                          onChange={(e) => setManual(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && connect()}
                          placeholder={t("lan.manualPlaceholder")}
                          className="min-w-0 flex-1 rounded-ui border-2 border-fog bg-snow px-3 py-2 text-sm font-semibold text-ink placeholder-smoke outline-none focus:border-accent"
                        />
                        <button
                          onClick={connect}
                          disabled={probing || !manual.trim()}
                          className="flex items-center gap-2 rounded-ui border-2 border-ink px-3 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50"
                        >
                          {probing ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} /> : <Link2 className="h-4 w-4" strokeWidth={2.25} />}
                          {t("lan.connect")}
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}
      </div>

      <LibraryPicker
        open={!!picker}
        multi={picker?.mode === "send"}
        title={picker?.mode === "send" ? t("lan.pickSend", { name: picker.peer.name }) : t("lan.pickRoom")}
        hint={picker?.mode === "send" ? t("lan.pickSendHint") : t("lan.pickRoomHint")}
        onDisk={!IS_ANDROID && picker?.mode === "send" ? () => pickFromDisk(picker.peer) : undefined}
        onClose={() => setPicker(null)}
        onPick={(videos) => {
          const p = picker;
          setPicker(null);
          if (!p || !videos.length) return;
          if (p.mode === "send") void send(p.peer, videos.map((v) => v.file_path));
          else void hostRoom(videos[0]);
        }}
      />
    </div>
  );
}
