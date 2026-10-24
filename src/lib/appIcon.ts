import { setAppIcon } from "./ipc";
import { IS_ANDROID } from "./platform";

/**
 * Знак Mestia — «Мягкая Ушба»: две скруглённые вершины складываются в M,
 * в долине вырезан play (viewBox 0 0 256 256, исходники и концепты — design/logo/).
 * Цвет — currentColor, чтобы знак красился под тему.
 */
export const LOGO_MARK =
  '<path fill="currentColor" fill-rule="evenodd" d="M35.9 189.1 L79.0 79.9 Q90.0 52.0 103.1 79.0 L118.4 110.2 Q128.0 130.0 141.9 112.9 L155.6 96.2 Q172.0 76.0 182.1 100.0 L219.8 189.3 Q226.0 204.0 210.0 204.0 L46.0 204.0 Q30.0 204.0 35.9 189.1 Z M110.0 146.0 L110.0 178.0 Q110.0 186.0 116.9 182.0 L145.1 166.0 Q152.0 162.0 145.1 158.0 L116.9 142.0 Q110.0 138.0 110.0 146.0 Z"/>';

/** Плитка-иконка: скруглённый квадрат цвета акцента + белый знак. */
export function iconSvg(bg: string, fg = "#ffffff"): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" color="${fg}">` +
    `<rect width="256" height="256" rx="56" fill="${bg}"/>` +
    `<g transform="translate(23 23) scale(0.8203)">${LOGO_MARK}</g></svg>`
  );
}

let seq = 0;

/** Перекрашивает favicon, иконку окна и трея под акцент текущей темы. */
export function applyThemeIcon(): void {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--c-accent").trim();
  if (!accent) return;
  const svg = iconSvg(accent);
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = url;

  if (IS_ANDROID) return;
  // Растеризуем в RGBA и отдаём в Rust; устаревшие отрисовки отбрасываем.
  const id = ++seq;
  const img = new Image();
  img.onload = () => {
    if (id !== seq) return;
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    setAppIcon(Array.from(data), size, size).catch(() => {});
  };
  img.src = url;
}
