import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AlertCircle, Check, Clipboard, Cpu, Download, FileAudio, FileText, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import LibraryPicker from "../components/LibraryPicker";
import Modal from "../components/Modal";
import { useI18n } from "../context/LanguageContext";
import { formatBytes, getSetting, setSetting } from "../lib/ipc";
import type { VideoRow } from "../types";

const MODELS = [
  ["tiny", "Whisper Tiny", 77691713, "asr.tiny"],
  ["base", "Whisper Base", 147951465, "asr.base"],
  ["base.en", "Whisper Base.en", 147964211, "asr.base"],
  ["small", "Whisper Small", 487601967, "asr.small"],
  ["small.en", "Whisper Small.en", 487614201, "asr.small"],
  ["medium", "Whisper Medium", 1533763059, "asr.medium"],
  ["large-v3-turbo-q5_0", "Whisper Large v3 Turbo Q5", 574041195, "asr.turboQ5"],
  ["large-v3-turbo", "Whisper Large v3 Turbo", 1624555275, "asr.turbo"],
  ["large-v3-q5_0", "Whisper Large v3 Q5", 1081140203, "asr.largeQ5"],
] as const;
type Model = typeof MODELS[number];
type Info = { cores: number; recommended: string; ready: boolean; vram: number | null; cached_models: string[] };
const LANGUAGES = ["auto", "ru", "en", "zh", "uk", "de", "fr", "es", "it", "pt", "ja", "ko", "tr", "ar", "hi", "ka"] as const;
type Options = { language: string; translate: boolean; timestamps: boolean };
const DEFAULT_OPTIONS: Options = { language: "auto", translate: false, timestamps: false };
type Update = { kind: "download" | "engine"; value: number } | { kind: "log"; value: string } |
  { kind: "prepare" | "recognize" | "cpu_fallback" };

export default function Transcription({ file, busy, onBusyChange }: {
  file: VideoRow | null;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<Info>();
  const [model, setModel] = useState("");
  const [modelToDelete, setModelToDelete] = useState<Model>();
  const [modelOperation, setModelOperation] = useState<{ id: string; removing: boolean; bytes: number }>();
  const [modelError, setModelError] = useState<{ id: string; detail: string }>();
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<Exclude<Update, { kind: "log" }>>();
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<string>();
  const [resultTimed, setResultTimed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [device, setDevice] = useState<string>();
  const [savingDevice, setSavingDevice] = useState(false);
  const [options, setOptions] = useState<Options>();
  const [savingOptions, setSavingOptions] = useState(false);
  const englishOnly = model.endsWith(".en");
  const canTranslate = !!model && !englishOnly && !model.includes("turbo");

  useEffect(() => {
    invoke<Info>("transcription_info").then(setInfo).catch((e) => setError(String(e)));
    getSetting("transcriptionDevice")
      .then((value) => setDevice(value === "cpu" || value === "gpu" ? value : "auto"))
      .catch((e) => setError(String(e)));
    getSetting("transcriptionOptions").then((value) => {
      let saved: Partial<Options> | null = null;
      try { saved = value ? JSON.parse(value) : null; }
      catch { /* Повреждённую настройку заменяем значениями по умолчанию. */ }
      setOptions({
        language: LANGUAGES.some((language) => language === saved?.language) ? saved!.language! : "auto",
        translate: saved?.translate === true,
        timestamps: saved?.timestamps === true,
      });
    }).catch((e) => setError(String(e)));
  }, []);

  async function changeOptions(patch: Partial<Options>) {
    const next = { ...DEFAULT_OPTIONS, ...options, ...patch };
    setSavingOptions(true);
    try {
      await setSetting("transcriptionOptions", JSON.stringify(next));
      setOptions(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingOptions(false);
    }
  }

  async function changeDevice(value: string) {
    setSavingDevice(true);
    try {
      await setSetting("transcriptionDevice", value);
      setDevice(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDevice(false);
    }
  }

  function setCached(id: string, cached: boolean) {
    setInfo((current) => {
      if (!current || current.cached_models.includes(id) === cached) return current;
      return { ...current, cached_models: cached ? [...current.cached_models, id] : current.cached_models.filter((name) => name !== id) };
    });
  }

  async function changeModel(id: string, removing: boolean) {
    setModelToDelete(undefined);
    setModelError(undefined);
    setModelOperation({ id, removing, bytes: 0 });
    onBusyChange(true);
    try {
      if (removing) await invoke("delete_transcription_model", { model: id });
      else {
        const updates = new Channel<{ kind: "download"; value: number }>();
        updates.onmessage = ({ value }) => setModelOperation((current) => current?.id === id ? { ...current, bytes: value } : current);
        await invoke("download_transcription_model", { model: id, updates });
      }
      setCached(id, !removing);
    } catch (e) {
      setModelError({ id, detail: String(e) });
    } finally {
      setModelOperation(undefined);
      onBusyChange(false);
    }
  }

  async function start(file: VideoRow) {
    setPicking(false);
    onBusyChange(true);
    setTitle(file.title);
    setStage(undefined);
    setLogs([]);
    setResult(undefined);
    setResultTimed(!!options?.timestamps);
    setCopied(false);
    setError("");
    const updates = new Channel<Update>();
    updates.onmessage = (update) => {
      if (update.kind === "log") setLogs((lines) => [...lines.slice(-299), update.value]);
      else {
        setStage(update);
        if (update.kind === "prepare") setCached(model, true);
      }
    };
    try {
      setResult(await invoke<string>("transcribe", {
        model, path: file.file_path, updates,
        options: { ...options, language: englishOnly ? "en" : options?.language, translate: canTranslate && options?.translate },
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      onBusyChange(false);
    }
  }

  async function exportTranscript(format: "txt" | "md") {
    if (result === undefined) return;
    setExporting(true);
    try {
      await invoke("save_transcript", { transcript: result, title, format, timestamps: resultTimed });
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  const selected = MODELS.find(([id]) => id === model);
  const needsModel = !!selected && !info?.cached_models.includes(model);
  const status = stage?.kind === "engine"
        ? t("asr.engine", { size: formatBytes(stage.value) })
        : stage?.kind === "cpu_fallback" ? t("asr.fallback") : stage?.kind === "download"
        ? t("asr.download", { size: formatBytes(stage.value) })
        : t(stage?.kind === "prepare" ? "asr.prepare" : stage?.kind === "recognize" ? "asr.recognize" : "asr.start");

  return (
    <section className="mx-auto max-w-6xl space-y-5 px-5 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-fog pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("nav.transcription")}</h1>
          <p className="mt-1 max-w-xl text-sm text-smoke">{t("asr.intro")}</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-1.5 text-xs font-semibold">
          <ShieldCheck className="size-4 text-accent" aria-hidden="true" /> {t("asr.local")}
        </span>
      </header>

      <div className="space-y-5">
        <fieldset disabled={busy} className="min-w-0 space-y-2 disabled:opacity-70">
          <legend className="mb-2 text-base font-bold">1. {t("asr.chooseModel")}</legend>
          {info && <p className="flex items-start gap-2 text-xs text-smoke">
            <Cpu className="size-4 shrink-0" aria-hidden="true" />
            {info.vram ? t("asr.gpu", { cores: info.cores, memory: formatBytes(info.vram * 1024 ** 2) })
              : t("asr.hardware", { cores: info.cores })}
          </p>}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {MODELS.map((entry) => {
              const [id, name, bytes, key] = entry;
              const cached = info?.cached_models.includes(id);
              const changing = modelOperation?.id === id ? modelOperation : undefined;
              const action = t(cached ? "asr.deleteModel" : "asr.downloadModel");
              const Icon = cached ? Trash2 : Download;
              return (
                <div key={id} className="flex min-w-0 flex-col gap-2 rounded-ui border-2 border-fog p-3 has-[:checked]:border-accent has-[:checked]:bg-fog hover:border-smoke">
                  <label className="flex flex-1 cursor-pointer items-start gap-2 has-[:disabled]:cursor-default">
                    <input type="radio" name="whisper-model" checked={model === id}
                      onChange={() => setModel(id)} className="mt-0.5 size-4 shrink-0 accent-accent" />
                    <span className="min-w-0 space-y-1">
                      <strong className="block text-sm leading-tight">{name}</strong>
                      <span className="block text-xs text-smoke">{t(key)}</span>
                      <span className="block text-xs font-semibold text-smoke">
                        {id.endsWith(".en") ? t("asr.english") : t("asr.multilingual")} · {formatBytes(bytes)}
                        {cached && ` · ${t("asr.cachedModel")}`}
                      </span>
                      {info?.recommended === id && <span className="inline-block rounded-ui bg-accent/10 px-2 py-0.5 text-xs font-bold text-accent">{t("asr.recommended")}</span>}
                    </span>
                  </label>
                  <button type="button" disabled={!info}
                    aria-label={t("asr.modelAction", { action, model: name })}
                    onClick={() => cached ? setModelToDelete(entry) : void changeModel(id, false)}
                    className="inline-flex items-center gap-1.5 self-start rounded-ui border-2 border-fog px-2 py-1 text-xs font-semibold hover:border-smoke disabled:opacity-50">
                    <Icon className="size-3.5" aria-hidden="true" /> {action}
                  </button>
                  {changing && <p role="status" className="text-xs text-smoke">
                    {changing.removing ? t("asr.deletingModel") : t("asr.download", { size: formatBytes(changing.bytes) })}
                  </p>}
                  {modelError?.id === id && <p role="alert" className="break-words text-xs text-rose-500">
                    {t("asr.error", { detail: modelError.detail })}
                  </p>}
                </div>
              );
            })}
          </div>
        </fieldset>

        <section className="min-w-0 space-y-3">
          <h2 className="text-base font-bold">2. {t("asr.recognitionSettings")}</h2>
          <fieldset disabled={busy} aria-label={t("asr.recognitionSettings")} className="grid gap-4 rounded-ui border-2 border-fog p-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <label className="block space-y-1 text-sm font-semibold">
                <span className="flex items-center gap-2">
                  <Cpu className="size-4 text-accent" aria-hidden="true" />
                  {t("asr.device")}
                </span>
                <select value={device ?? "auto"} onChange={(event) => void changeDevice(event.target.value)}
                  disabled={!device || savingDevice} aria-describedby="transcription-device-hint"
                  className="w-full rounded-ui border-2 border-fog bg-snow px-3 py-2 disabled:opacity-60">
                  <option value="auto">{t("asr.auto")}</option>
                  <option value="gpu">{t("asr.cuda")}</option>
                  <option value="cpu">{t("asr.cpu")}</option>
                </select>
              </label>
              <p id="transcription-device-hint" className="text-xs text-smoke">
                {t("asr.deviceHint")}
              </p>
            </div>
            <label className="block space-y-1 text-sm font-semibold">
              <span>{t("asr.spokenLanguage")}</span>
              <select value={englishOnly ? "en" : options?.language ?? "auto"}
                disabled={englishOnly || !options || savingOptions} onChange={(event) => void changeOptions({ language: event.target.value })}
                className="w-full rounded-ui border-2 border-fog bg-snow px-3 py-2 disabled:opacity-60">
                {LANGUAGES.map((language) => <option key={language} value={language}>{t("asr.lang." + language)}</option>)}
              </select>
              <span className="block text-xs font-normal text-smoke">{t(englishOnly ? "asr.english" : "asr.languageHint")}</span>
            </label>
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm font-semibold">
                <input type="checkbox" checked={canTranslate && !!options?.translate} disabled={!canTranslate || !options || savingOptions}
                  onChange={(event) => void changeOptions({ translate: event.target.checked })} className="mt-0.5 size-4 shrink-0 accent-accent" />
                {t("asr.translateEnglish")}
              </label>
              <p className="text-xs text-smoke">{t(canTranslate ? "asr.translateHint" : "asr.translateUnavailable")}</p>
            </div>
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm font-semibold">
                <input type="checkbox" checked={!!options?.timestamps} disabled={!options || savingOptions}
                  onChange={(event) => void changeOptions({ timestamps: event.target.checked })} className="mt-0.5 size-4 shrink-0 accent-accent" />
                {t("asr.timestamps")}
              </label>
              <p className="text-xs text-smoke">{t("asr.timestampsHint")}</p>
            </div>
          </fieldset>
        </section>

        <section className="min-w-0 space-y-3 rounded-ui border-2 border-fog p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="font-bold">3. {t("asr.chooseFile")}</h2>
              <p className="text-sm text-smoke">{selected
                ? t("asr.selected", { model: selected[1] })
                : t("asr.chooseFirst")}</p>
              {file && <p className="break-words text-sm font-semibold">{file.title}</p>}
            </div>
            <button disabled={!selected || !device || !options || busy || exporting || savingDevice || savingOptions || !info?.ready}
              onClick={() => file ? void start(file) : setPicking(true)}
              className="flex items-center justify-center gap-2 rounded-ui border-2 border-ink bg-accent px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              <FileAudio className="size-4" aria-hidden="true" /> {t(file ? needsModel ? "asr.downloadAndRun" : "asr.run" : "asr.pick")}
            </button>
          </div>
          {info && !info.ready && (
            <div className="flex gap-2 rounded-ui border-2 border-fog bg-fog/40 p-3 text-xs">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <a className="underline" href="https://github.com/ggml-org/whisper.cpp/releases" target="_blank" rel="noreferrer">{t("asr.setup")}</a>
            </div>
          )}
          {title && <p className="break-words text-sm font-semibold">{title}</p>}
          {busy && !modelOperation && <p role="status" className="flex items-center gap-2 text-sm font-semibold text-accent">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> {status}
          </p>}
          {/* Alert из 21st.dev: иконка и сообщение об ошибке. */}
          {error && <div role="alert" className="flex items-start gap-2 rounded-ui border-2 border-rose-500/40 p-3 text-sm text-rose-500">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <p className="break-all">{t("asr.error", { detail: error })}</p>
          </div>}
          {result !== undefined && !result.trim() && (
            <p role="status" className="text-sm text-smoke">{t("asr.noSpeech")}</p>
          )}
          {result !== undefined && !!result.trim() && <div className="space-y-3 border-t-2 border-fog pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-bold"><FileText className="size-4 text-accent" aria-hidden="true" /> {t("asr.result")}</h3>
              <div className="flex flex-wrap gap-2">
                <button className="flex items-center gap-2 rounded-ui border-2 border-fog px-3 py-1.5 text-sm font-semibold hover:bg-fog"
                  onClick={() => void writeText(result).then(() => setCopied(true)).catch((e) => setError(String(e)))}>
                  {copied ? <Check className="size-4" aria-hidden="true" /> : <Clipboard className="size-4" aria-hidden="true" />}
                  {t(copied ? "asr.copied" : "asr.copy")}
                </button>
                {(["txt", "md"] as const).map((format) => (
                  <button key={format} disabled={exporting} onClick={() => void exportTranscript(format)}
                    className="rounded-ui border-2 border-fog px-3 py-1.5 text-sm font-semibold hover:bg-fog disabled:opacity-60">
                    {t("asr.saveFormat", { format: format.toUpperCase() })}
                  </button>
                ))}
              </div>
            </div>
            <textarea aria-label={t("asr.result")} readOnly value={result} rows={10} className="w-full rounded-ui border-2 border-fog bg-snow p-3 text-sm leading-relaxed" />
          </div>}
          {logs.length > 0 && <details open={busy && !modelOperation} className="rounded-ui border-2 border-fog">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{t("asr.log")}</summary>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t-2 border-fog bg-fog/40 p-3 text-xs">{logs.join("\n")}</pre>
          </details>}
        </section>
      </div>
      <LibraryPicker open={picking} multi={false} title={t("asr.pick")} hint={t("asr.intro")}
        onClose={() => setPicking(false)} onPick={([file]) => { if (file) void start(file); }} />
      <Modal open={!!modelToDelete} onClose={() => setModelToDelete(undefined)}>
        {modelToDelete && <div role="dialog" aria-modal="true" aria-labelledby="delete-model-title" className="space-y-4">
          <h2 id="delete-model-title" className="font-bold">{t("asr.deleteModelTitle", { model: modelToDelete[1] })}</h2>
          <p className="text-sm text-smoke">{t("asr.deleteModelHint")}</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setModelToDelete(undefined)} className="rounded-ui border-2 border-fog px-3 py-2 text-sm font-semibold hover:bg-fog">
              {t("common.cancel")}
            </button>
            <button disabled={busy} onClick={() => void changeModel(modelToDelete[0], true)}
              className="rounded-ui border-2 border-ink bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              {t("asr.deleteModel")}
            </button>
          </div>
        </div>}
      </Modal>
    </section>
  );
}
