/**
 * Скачивает sidecar-бинарники для Tauri и кладёт их в src-tauri/binaries
 * с обязательным суффиксом target triple (требование Tauri sidecar).
 *
 *   node scripts/fetch-binaries.mjs
 *
 * Качает yt-dlp + ffmpeg/ffprobe под текущую ОС и архитектуру:
 *   Windows — BtbN; macOS — martin-riedl.de (нативно arm64/amd64), запасной evermeet;
 *   Linux — johnvansickle/BtbN. yt-dlp на macOS — универсальный бинарь.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, rmSync, readdirSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "src-tauri", "binaries");

// Universal-сборка macOS (Intel + Apple Silicon в одном бинарнике) — включается
// переменной окружения в CI (MESTIA_MAC_UNIVERSAL=1). Локально не трогаем.
const MAC_UNIVERSAL =
  os.platform() === "darwin" && process.env.MESTIA_MAC_UNIVERSAL === "1";

// ── Определяем target triple (как у `rustc -Vv` host) ─────────────────────────
function targetTriple() {
  // В universal-режиме triple фиксирован — host (arm64) тут не подходит.
  if (MAC_UNIVERSAL) return "universal-apple-darwin";
  try {
    const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const m = out.match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* rustc не установлен — используем сопоставление по платформе */
  }
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  if (platform === "darwin")
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "linux") return "x86_64-unknown-linux-gnu";
  throw new Error(`Неизвестная платформа: ${platform}/${arch}`);
}

const TRIPLE = targetTriple();
const IS_WIN = os.platform() === "win32";
const EXE = IS_WIN ? ".exe" : "";

async function download(url, dest) {
  process.stdout.write(`  ↓ ${url}\n`);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        console.log(`    попытка ${attempt} не удалась (${e.message}), повтор…`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw new Error(`не удалось скачать ${url}: ${lastErr?.message}`);
}

async function fetchYtDlp() {
  const asset = IS_WIN
    ? "yt-dlp.exe"
    : os.platform() === "darwin"
    ? "yt-dlp_macos"
    : "yt-dlp_linux";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = join(BIN_DIR, `yt-dlp-${TRIPLE}${EXE}`);
  await download(url, dest);
  if (!IS_WIN) execFileSync("chmod", ["+x", dest]);
  console.log(`  ✓ yt-dlp → ${dest}`);
}

async function fetchFfmpegWindows() {
  const zipUrl =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
  const tmpZip = join(os.tmpdir(), "mestia-ffmpeg.zip");
  const tmpDir = join(os.tmpdir(), "mestia-ffmpeg");

  await download(zipUrl, tmpZip);

  rmSync(tmpDir, { recursive: true, force: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force`,
  ]);

  // Находим bin/ с ffmpeg.exe и ffprobe.exe внутри распакованной папки.
  const top = readdirSync(tmpDir);
  const binPath = join(tmpDir, top[0], "bin");
  for (const name of ["ffmpeg", "ffprobe"]) {
    const src = join(binPath, `${name}.exe`);
    const dst = join(BIN_DIR, `${name}-${TRIPLE}.exe`);
    copyFileSync(src, dst);
    console.log(`  ✓ ${name} → ${dst}`);
  }

  rmSync(tmpZip, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
}

// Скачивает ffmpeg/ffprobe одной архитектуры ("arm64"|"amd64") во временный
// файл и возвращает путь к бинарю. martin-riedl.de даёт обе архитектуры; для
// Intel есть запасной evermeet.cx.
async function downloadMacFfmpeg(name, arch) {
  const urls = [
    `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/${name}.zip`,
  ];
  if (arch === "amd64") {
    urls.push(
      name === "ffmpeg"
        ? "https://evermeet.cx/ffmpeg/getrelease/zip"
        : "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
    );
  }
  let lastErr;
  for (const url of urls) {
    const tmpZip = join(os.tmpdir(), `mestia-${name}-${arch}.zip`);
    const tmpDir = join(os.tmpdir(), `mestia-${name}-${arch}`);
    try {
      await download(url, tmpZip);
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      execFileSync("unzip", ["-o", tmpZip, "-d", tmpDir]);
      const src = findFile(tmpDir, name);
      if (!src) throw new Error(`${name} не найден в архиве`);
      const out = join(os.tmpdir(), `mestia-${name}-${arch}.bin`);
      copyFileSync(src, out);
      return out;
    } catch (e) {
      lastErr = e;
    } finally {
      rmSync(tmpZip, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  throw lastErr ?? new Error(`не удалось получить ${name} (${arch}) для macOS`);
}

async function fetchFfmpegMac() {
  for (const name of ["ffmpeg", "ffprobe"]) {
    const dst = join(BIN_DIR, `${name}-${TRIPLE}`);
    if (MAC_UNIVERSAL) {
      // Склеиваем arm64 + x86_64 в один universal-бинарь — это требование Tauri
      // для сборки --target universal-apple-darwin.
      const arm = await downloadMacFfmpeg(name, "arm64");
      const intel = await downloadMacFfmpeg(name, "amd64");
      execFileSync("lipo", ["-create", arm, intel, "-output", dst]);
      rmSync(arm, { force: true });
      rmSync(intel, { force: true });
      console.log(`  ✓ ${name} (universal) → ${dst}`);
    } else {
      const arch = os.arch() === "arm64" ? "arm64" : "amd64";
      const bin = await downloadMacFfmpeg(name, arch);
      copyFileSync(bin, dst);
      rmSync(bin, { force: true });
      console.log(`  ✓ ${name} (${arch}) → ${dst}`);
    }
    execFileSync("chmod", ["+x", dst]);
  }
}

// Рекурсивно ищет файл с именем name в каталоге dir.
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

// Скачивает tar.xz по url и извлекает из него ffmpeg/ffprobe (структура любая).
async function extractFfmpegTar(url) {
  const tmpTar = join(os.tmpdir(), "mestia-ffmpeg.tar.xz");
  const tmpDir = join(os.tmpdir(), "mestia-ffmpeg");
  await download(url, tmpTar);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  execFileSync("tar", ["xf", tmpTar, "-C", tmpDir]);
  for (const name of ["ffmpeg", "ffprobe"]) {
    const src = findFile(tmpDir, name);
    if (!src) throw new Error(`${name} не найден в архиве`);
    const dst = join(BIN_DIR, `${name}-${TRIPLE}`);
    copyFileSync(src, dst);
    execFileSync("chmod", ["+x", dst]);
    console.log(`  ✓ ${name} → ${dst}`);
  }
  rmSync(tmpTar, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
}

async function fetchFfmpegLinux() {
  const arm = os.arch() === "arm64";
  // Несколько источников статичных сборок — пробуем по очереди.
  const sources = [
    `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arm ? "arm64" : "amd64"}-static.tar.xz`,
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arm ? "linuxarm64" : "linux64"}-gpl.tar.xz`,
  ];
  let lastErr;
  for (const url of sources) {
    try {
      await extractFfmpegTar(url);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  ⚠ источник недоступен (${e.message}), пробую следующий…`);
    }
  }
  throw lastErr ?? new Error("не удалось получить ffmpeg для Linux");
}

async function main() {
  console.log(`\nMestia · загрузка sidecar-бинарников (triple: ${TRIPLE})\n`);
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

  await fetchYtDlp();

  const platform = os.platform();
  if (IS_WIN) await fetchFfmpegWindows();
  else if (platform === "darwin") await fetchFfmpegMac();
  else if (platform === "linux") await fetchFfmpegLinux();
  else {
    console.log(
      `\n  ⚠ Автозагрузка ffmpeg для ${platform} не поддерживается — положите\n` +
        `    ffmpeg-${TRIPLE} и ffprobe-${TRIPLE} в src-tauri/binaries вручную.`
    );
  }

  console.log("\nГотово. Бинарники в src-tauri/binaries\n");
}

main().catch((e) => {
  console.error(`\n  ✖ Ошибка: ${e.message}\n`);
  process.exit(1);
});
