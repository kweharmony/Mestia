// Рендер промо-ролика: promo.html → кадры PNG → MP4 (H.264) + анимированный WebP + постер.
//
//   npm i --no-save playwright-core        (или PLAYWRIGHT_CORE=<путь к пакету>)
//   node design/promo/render.mjs [ru|en]
//
// Браузер — любой Chromium: CHROME=<путь к chrome.exe>, иначе ищем в кэше Playwright.
// ffmpeg — FFMPEG=<путь>, иначе sidecar из src-tauri/binaries (npm run fetch-binaries).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const lang = process.argv[2] === "en" ? "en" : "ru";
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

const frames = join(tmpdir(), `mestia-promo-${lang}`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(join(here, "promo.html")).href}?lang=${lang}`);
await page.evaluate(() => document.fonts.ready);
const total = Math.round((await page.evaluate(() => window.DURATION)) * FPS);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.seek(t), i / FPS);
  await page.screenshot({ path: join(frames, `f${String(i).padStart(4, "0")}.png`) });
  if (i % 60 === 0) process.stdout.write(`кадр ${i}/${total}\n`);
}
await browser.close();

const out = join(root, "docs/media");
mkdirSync(out, { recursive: true });
const suffix = lang === "en" ? ".en" : "";
const ff = findFfmpeg();
const input = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "f%04d.png")];
execFileSync(ff, [...input, "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", join(out, `promo${suffix}.mp4`)], { stdio: "inherit" });
execFileSync(ff, [...input, "-vf", "fps=15,scale=960:-1:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0",
  "-q:v", "72", "-loop", "0", join(out, `promo${suffix}.webp`)], { stdio: "inherit" });
// Постер — кадр финала (знак + ссылка), он же og:image сайта; в финале нет текста
// на языке, поэтому он общий и пишется только при русском рендере.
if (lang === "ru") {
  execFileSync(ff, ["-y", "-hide_banner", "-loglevel", "error", "-i", join(frames, `f${String(total - 1).padStart(4, "0")}.png`),
    join(out, "poster.png")], { stdio: "inherit" });
}
rmSync(frames, { recursive: true, force: true });
console.log(`готово: docs/media/promo${suffix}.mp4, promo${suffix}.webp`);
