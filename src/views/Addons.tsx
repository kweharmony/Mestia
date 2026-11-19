import { useEffect, useState, type ReactNode } from "react";
import {
  AudioLines, Clapperboard, Download, FileText, Loader2, Music, Pencil, Radar, Send,
  ShieldCheck, Timer, Trash2, Video, type LucideIcon,
} from "lucide-react";
import Modal from "../components/Modal";
import { IS_ANDROID } from "../lib/platform";
import { useI18n } from "../context/LanguageContext";
import {
  formatBytes, humanizeError, installTranscriptionAddon, transcriptionAddonStorage,
  uninstallTranscriptionAddon, type AddonPackageId, type AddonPackageStatus, type TranscriptionAddonStorage,
} from "../lib/ipc";

const DOWNLOADABLE_ADDONS = [
  {
    id: "tags", title: "addons.tags", description: "addons.tagsDescription", icon: Pencil,
    features: [{ icon: Music, label: "lib.audio" }, { icon: Video, label: "lib.video" }],
  },
  {
    id: "nearby", title: "nav.nearby", description: "lan.subtitle", icon: Radar,
    features: [{ icon: Send, label: "lan.sendFiles" }, { icon: Clapperboard, label: "lan.together" }],
  },
] as const;

const TRANSCRIPTION_FEATURES = [
  { icon: ShieldCheck, label: "asr.local" },
  { icon: Timer, label: "addons.timestamps" },
  { icon: FileText, label: "addons.transcriptExport" },
];

function AddonCard({ title, description, icon: Icon, features, children }: {
  title: string;
  description: string;
  icon: LucideIcon;
  features: readonly { icon: LucideIcon; label: string }[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <article className="flex h-full flex-col gap-4 rounded-ui border-2 border-fog bg-paper/30 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-ui bg-accent/10 p-2.5 text-accent">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-bold">{t(title)}</h2>
          <p className="mt-1 text-sm text-smoke">{t(description)}</p>
        </div>
      </div>
      <ul className="flex flex-wrap gap-2">
        {features.map(({ icon: FeatureIcon, label }) => (
          <li key={label} className="inline-flex items-center gap-1.5 rounded-ui bg-fog/70 px-2 py-1 text-xs font-semibold text-ink">
            <FeatureIcon className="size-3.5 shrink-0 text-accent" aria-hidden="true" /> {t(label)}
          </li>
        ))}
      </ul>
      <div className="mt-auto space-y-3">{children}</div>
    </article>
  );
}

export default function Addons({ active, installed, transcriptionBusy, onOpen, onInstalledChange,
  packages, nearbyBusy, downloadsBusy, loadError, onRetry, onPackageInstall, onPackageRemove, onPackageOpen }: {
  active: boolean;
  installed: boolean | null | undefined;
  transcriptionBusy: boolean;
  onOpen: () => void;
  onInstalledChange: (installed: boolean) => void;
  packages: Record<AddonPackageId, AddonPackageStatus> | undefined;
  nearbyBusy: boolean;
  downloadsBusy: boolean;
  loadError: boolean;
  onRetry: () => void;
  onPackageInstall: (id: AddonPackageId, onProgress: (bytes: number) => void) => Promise<void>;
  onPackageRemove: (id: AddonPackageId) => Promise<void>;
  onPackageOpen: (id: AddonPackageId) => void;
}) {
  const { t } = useI18n();
  const [operation, setOperation] = useState<"install" | "remove">();
  const [downloaded, setDownloaded] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [keepModels, setKeepModels] = useState(false);
  const [storage, setStorage] = useState<TranscriptionAddonStorage>();
  const [error, setError] = useState("");
  const [packageOperation, setPackageOperation] = useState<{ id: AddonPackageId; remove: boolean }>();
  const [packageBytes, setPackageBytes] = useState(0);
  const [removingPackage, setRemovingPackage] = useState<AddonPackageId>();
  const [packageError, setPackageError] = useState<{ id: AddonPackageId; message: string }>();
  const removalCard = DOWNLOADABLE_ADDONS.find(({ id }) => id === removingPackage);
  const totalBytes = storage ? storage.engineBytes + storage.modelBytes : 0;
  const bytesToRemove = keepModels ? storage?.engineBytes ?? 0 : totalBytes;
  const androidBusy = IS_ANDROID && (downloadsBusy || nearbyBusy);

  useEffect(() => {
    if (!active || typeof installed !== "boolean" || operation || transcriptionBusy) return;
    let current = true;
    void transcriptionAddonStorage().then((size) => {
      if (current) setStorage(size);
    }).catch(() => {});
    return () => { current = false; };
  }, [active, installed, operation, transcriptionBusy]);

  async function changePackage(id: AddonPackageId, remove: boolean) {
    setRemovingPackage(undefined);
    setPackageError(undefined);
    setPackageBytes(0);
    setPackageOperation({ id, remove });
    try {
      if (remove) await onPackageRemove(id);
      else await onPackageInstall(id, setPackageBytes);
    } catch (e) {
      setPackageError({ id, message: humanizeError(e) });
    } finally {
      setPackageOperation(undefined);
    }
  }

  async function install() {
    setError("");
    setDownloaded(0);
    setOperation("install");
    try {
      await installTranscriptionAddon(setDownloaded);
      onInstalledChange(true);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setOperation(undefined);
    }
  }

  async function remove() {
    setConfirmRemove(false);
    setError("");
    setOperation("remove");
    try {
      await uninstallTranscriptionAddon(keepModels);
      setStorage((current) => current && { engineBytes: 0, modelBytes: keepModels ? current.modelBytes : 0 });
      onInstalledChange(false);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setOperation(undefined);
    }
  }

  return (
    <section className="mx-auto grid max-w-6xl items-start gap-4 px-5 py-6 md:px-8 lg:grid-cols-2 xl:grid-cols-3">
      <h1 className="col-span-full border-b-2 border-fog pb-4 text-2xl font-bold tracking-tight">{t("nav.addons")}</h1>
      {loadError ? <div className="col-span-full flex flex-wrap items-center gap-3 text-sm">
        <p role="alert" className="text-rose-500">{t("addons.loadError")}</p>
        <button onClick={onRetry} className="rounded-ui border-2 border-fog px-3 py-2 font-semibold hover:bg-fog">
          {t("addons.retry")}
        </button>
      </div> : installed !== null && !packages && <p role="status" className="col-span-full text-sm text-smoke">{t("addons.loading")}</p>}
      {androidBusy && <p role="status" className="col-span-full text-sm text-smoke">{t("addons.androidBusy")}</p>}
      {installed !== undefined && <AddonCard title="nav.transcription" description="asr.intro" icon={AudioLines} features={TRANSCRIPTION_FEATURES}>
        {totalBytes > 0 && <p className="text-sm text-smoke">{t("addons.downloadedSize", { size: formatBytes(totalBytes) })}</p>}
        <div className="flex flex-wrap gap-2">
          {installed !== false ? (
            <button disabled={!!operation} onClick={() => onOpen()}
              className="rounded-ui border-2 border-ink bg-accent px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              {t("addons.open")}
            </button>
          ) : (
            <button disabled={!!operation} onClick={() => void install()}
              className="inline-flex items-center gap-2 rounded-ui border-2 border-ink bg-accent px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              <Download className="size-4" aria-hidden="true" /> {t("addons.install")}
            </button>
          )}
          {(installed || totalBytes > 0) && (
            <button disabled={!!operation || transcriptionBusy} onClick={() => {
              setKeepModels(false);
              setConfirmRemove(true);
            }} className="inline-flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50">
              <Trash2 className="size-4" aria-hidden="true" /> {t(installed ? "addons.remove" : "addons.deleteFiles")}
            </button>
          )}
        </div>
        {operation && <p role="status" className="flex items-center gap-2 text-sm text-smoke">
          <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          {operation === "remove" ? t("addons.removing") : downloaded > 0
            ? t("asr.engine", { size: formatBytes(downloaded) }) : t("addons.installing")}
        </p>}
        {error && <p role="alert" className="break-words text-sm text-rose-500">{error}</p>}
      </AddonCard>}
      {(IS_ANDROID || typeof installed === "boolean") && DOWNLOADABLE_ADDONS.map(({ id, ...card }) => {
        const status = packages?.[id];
        const busy = id === "nearby" && status?.installed && nearbyBusy;
        const changing = packageOperation?.id === id;
        return (
          <AddonCard key={id} {...card}>
            {!!status?.bytes && <p className="text-sm text-smoke">{t("addons.downloadedSize", { size: formatBytes(status.bytes) })}</p>}
            <div className="flex flex-wrap gap-2">
              {status?.installed ? (
                <button disabled={changing} onClick={() => onPackageOpen(id)}
                  className="rounded-ui border-2 border-ink bg-accent px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
                  {t("addons.open")}
                </button>
              ) : (
                <button disabled={!status || !!packageOperation || androidBusy} onClick={() => void changePackage(id, false)}
                  className="inline-flex items-center gap-2 rounded-ui border-2 border-ink bg-accent px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
                  <Download className="size-4" aria-hidden="true" /> {t("addons.install")}
                </button>
              )}
              {status?.present && <button disabled={!!packageOperation || busy || androidBusy} onClick={() => setRemovingPackage(id)}
                className="inline-flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog disabled:opacity-50">
                <Trash2 className="size-4" aria-hidden="true" /> {t("addons.remove")}
              </button>}
            </div>
            {changing && <p role="status" className="flex items-center gap-2 text-sm text-smoke">
              <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
              {packageOperation.remove ? t("addons.removing") : packageBytes > 0
                ? t("addons.packageProgress", { size: formatBytes(packageBytes) }) : t("addons.packageInstalling")}
            </p>}
            {busy && <p className="text-sm text-smoke">{t("addons.nearbyBusy")}</p>}
            {packageError?.id === id && <p role="alert" className="break-words text-sm text-rose-500">{packageError.message}</p>}
          </AddonCard>
        );
      })}
      <Modal open={!!removalCard} onClose={() => setRemovingPackage(undefined)}>
        {removalCard && <div role="dialog" aria-modal="true" aria-labelledby="package-remove-title" className="space-y-4">
          <h2 id="package-remove-title" className="font-bold">{t("addons.removePackageTitle", { name: t(removalCard.title) })}</h2>
          <div className="flex justify-end gap-2">
            <button onClick={() => setRemovingPackage(undefined)}
              className="rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog">
              {t("common.cancel")}
            </button>
            <button disabled={androidBusy || (removalCard.id === "nearby" && nearbyBusy)} onClick={() => void changePackage(removalCard.id, true)}
              className="rounded-ui border-2 border-ink bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              {t("addons.remove")}
            </button>
          </div>
        </div>}
      </Modal>
      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)}>
        <div role="dialog" aria-modal="true" aria-labelledby="addon-remove-title" className="space-y-4">
          <h2 id="addon-remove-title" className="font-bold">{t(installed ? "addons.removeTitle" : "addons.deleteFilesTitle")}</h2>
          {bytesToRemove > 0 && <p className="text-sm text-smoke">{t("addons.removalSize", { size: formatBytes(bytesToRemove) })}</p>}
          {installed && (!storage || storage.modelBytes > 0) && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keepModels} onChange={(event) => setKeepModels(event.target.checked)}
                className="size-4 shrink-0 accent-accent" />
              {t("addons.keepModels")}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmRemove(false)}
              className="rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog">
              {t("common.cancel")}
            </button>
            <button disabled={transcriptionBusy} onClick={() => void remove()}
              className="rounded-ui border-2 border-ink bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              {t(installed ? "addons.remove" : "addons.deleteFiles")}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
