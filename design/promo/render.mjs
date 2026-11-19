// Рендер промо-ролика: promo.html → кадры PNG → MP4 (H.264) + анимированный WebP + постер.
//
//   npm i --no-save playwright-core        (или PLAYWRIGHT_CORE=<путь к пакету>)
//   node design/promo/render.mjs [en|ru]   (по умолчанию en)
//
// Браузер — любой Chromium: CHROME=<путь к chrome.exe>, иначе ищем в кэше Playwright.
// ffmpeg — FFMPEG=<путь>, иначе sidecar из src-tauri/binaries (npm run fetch-binaries).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const lang = process.argv[2] ?? "en";
if (lang !== "en" && lang !== "ru") throw new Error(`Неизвестный язык ролика: ${lang}`);
const FPS = 30;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = process.platform === "win32"
    ? join(homedir(), "AppData/Local/ms-playwright")
    : join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : [];
  for (const d of dirs) {
    for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-linux64/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined; // пусть Playwright ищет сам
}

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const bin = join(root, "src-tauri/binaries");
  const f = existsSync(bin) && readdirSync(bin).find((n) => n.startsWith("ffmpeg"));
  return f ? join(bin, f) : "ffmpeg";
}

function framePath(frames, index) {
  return join(frames, `f${String(index).padStart(4, "0")}.png`);
}

async function capture(frames) {
  const browser = await chromium.launch({ executablePath: findChrome() });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${pathToFileURL(join(here, "promo.html")).href}?lang=${lang}`);
    await page.evaluate(() => document.fonts.ready);
    const total = Math.round((await page.evaluate(() => window.DURATION)) * FPS);
    if (!Number.isSafeInteger(total) || total < 1) throw new Error("Некорректная длительность ролика");
    for (let i = 0; i < total; i++) {
      await page.evaluate((t) => window.seek(t), i / FPS);
      if (errors.length) throw errors[0];
      await page.screenshot({ path: framePath(frames, i) });
      if (i % 120 === 0) console.log(`${lang}: кадр ${i}/${total}`);
    }
    return total;
  } finally {
    await browser.close();
  }
}

const temp = realpathSync(tmpdir());
const prefix = `mestia-promo-${lang}-`;
const frames = mkdtempSync(join(temp, prefix));
try {
  const total = await capture(frames);
  const out = join(root, "docs/media");
  mkdirSync(out, { recursive: true });
  const suffix = lang === "en" ? ".en" : "";
  const ff = findFfmpeg();
  const input = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "f%04d.png")];
  execFileSync(ff, [...input, "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", join(out, `promo${suffix}.mp4`)], { stdio: "inherit" });
  execFileSync(ff, [...input, "-vf", "fps=15,scale=960:-1:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0",
    "-q:v", "72", "-loop", "0", join(out, `promo${suffix}.webp`)], { stdio: "inherit" });
  // Общий постер — финальный кадр основного ролика.
  if (lang === "en") {
    execFileSync(ff, ["-y", "-hide_banner", "-loglevel", "error", "-i", framePath(frames, total - 1),
      join(out, "poster.png")], { stdio: "inherit" });
  }
  console.log(`готово: docs/media/promo${suffix}.mp4, promo${suffix}.webp`);
} finally {
  const actual = realpathSync(frames);
  if (dirname(actual) === temp && basename(actual).startsWith(prefix)) {
    rmSync(actual, { recursive: true, force: true });
  }
}
