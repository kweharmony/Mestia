import { beforeAll, describe, expect, it } from "vitest";
import {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  classifyError,
  estimateAudioBytes,
  formatBytes,
  formatDuration,
  formatSpeed,
  humanizeError,
  isAudioPath,
  isAuthError,
} from "./ipc";
import { setActiveLang } from "./i18n";

// humanizeError теперь зависит от активного языка i18n — фиксируем русский,
// чтобы проверять русский маппинг вне зависимости от локали окружения.
beforeAll(() => setActiveLang("ru"));

describe("formatBytes", () => {
  it("отдаёт прочерк для пустых/нулевых значений", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("—");
  });

  it("масштабирует по единицам", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });

  it("округляет до целого при значении ≥ 10", () => {
    expect(formatBytes(20 * 1024)).toBe("20 KB");
  });
});

describe("formatDuration", () => {
  it("прочерк для пустых значений", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("—");
  });

  it("минуты:секунды без часов", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(9)).toBe("0:09");
  });

  it("часы:минуты:секунды", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});

describe("formatSpeed", () => {
  it("добавляет /s или прочерк", () => {
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(1024)).toBe("1.0 KB/s");
  });
});

describe("isAudioPath", () => {
  it("распознаёт аудио по расширению", () => {
    expect(isAudioPath("song.mp3")).toBe(true);
    expect(isAudioPath("a/b/track.FLAC")).toBe(true);
    expect(isAudioPath("clip.mp4")).toBe(false);
    expect(isAudioPath(null)).toBe(false);
    expect(isAudioPath("noext")).toBe(false);
  });
});

describe("estimateAudioBytes", () => {
  it("считает размер по битрейту и длительности", () => {
    // 320 kbps · 60 c = 320000/8 * 60 = 2_400_000
    expect(estimateAudioBytes(60, "mp3_320")).toBe(2_400_000);
    expect(estimateAudioBytes(60, "mp3_128")).toBe(960_000);
    // FLAC: 900 kbps · 60 c = 900000/8 * 60 = 6_750_000
    expect(estimateAudioBytes(60, "flac")).toBe(6_750_000);
  });

  it("null для неизвестного пресета или пустой длительности", () => {
    // «Оригинал» (best) — битрейт заранее неизвестен → размер не оцениваем.
    expect(estimateAudioBytes(60, "best")).toBeNull();
    expect(estimateAudioBytes(null, "mp3_320")).toBeNull();
    expect(estimateAudioBytes(0, "mp3_320")).toBeNull();
  });
});

describe("каталог форматов", () => {
  it("видео-пресеты предпочитают H.264 для совместимого MP4", () => {
    // Регрессия: VP9/AV1 в MP4 ломают воспроизведение в Windows-плеере.
    for (const f of VIDEO_FORMATS) {
      expect(f.isAudio).toBe(false);
      expect(f.format).toContain("avc1");
    }
  });

  it("аудио-пресеты помечены как аудио", () => {
    for (const f of AUDIO_FORMATS) {
      expect(f.isAudio).toBe(true);
    }
  });
});

describe("isAuthError", () => {
  it("распознаёт ошибки доступа/входа yt-dlp", () => {
    expect(isAuthError("ERROR: Sign in to confirm you're not a bot")).toBe(true);
    expect(isAuthError("ERROR: Private video. Sign in if you've been granted access")).toBe(true);
    expect(isAuthError("This video is available to this channel's members on level: …")).toBe(true);
    expect(isAuthError("Use --cookies-from-browser or --cookies for the authentication")).toBe(true);
    expect(isAuthError("ERROR: confirm your age")).toBe(true);
  });

  it("не срабатывает на прочих ошибках и пустых значениях", () => {
    expect(isAuthError("ERROR: Unable to download webpage: HTTP Error 404")).toBe(false);
    expect(isAuthError("ERROR: Video unavailable")).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("")).toBe(false);
  });
});

describe("humanizeError", () => {
  it("переводит технические ошибки в понятный русский", () => {
    expect(humanizeError("failed to lookup address: getaddrinfo")).toMatch(/сетью/i);
    expect(humanizeError("Access is denied. (os error 5)")).toMatch(/доступ/i);
    expect(humanizeError("The system cannot find the file specified. (os error 2)")).toMatch(/не найден/i);
    expect(humanizeError("No space left on device")).toMatch(/место/i);
    expect(humanizeError("ERROR: Unsupported URL: https://example.com")).toMatch(/ссылк/i);
    expect(humanizeError("ERROR: Video unavailable")).toMatch(/недоступно/i);
  });

  it("наши русские сообщения оставляет как есть", () => {
    expect(humanizeError("Папка не выбрана")).toBe("Папка не выбрана");
  });

  it("пустое и неизвестное → общий дружелюбный текст", () => {
    expect(humanizeError("")).toMatch(/что-то пошло не так/i);
    expect(humanizeError("RuntimeError: weird internal failure xyz")).toMatch(/что-то пошло не так/i);
  });

  it("новые сигнатуры yt-dlp: rate-limit/403 → сеть, битый экстрактор → ссылка", () => {
    expect(humanizeError("ERROR: HTTP Error 429: Too Many Requests")).toMatch(/сет/i);
    expect(humanizeError("ERROR: unable to download webpage: HTTP Error 403: Forbidden")).toMatch(/сет/i);
    expect(humanizeError("ERROR: nsig extraction failed: Some formats may be missing")).toMatch(/ссылк/i);
    expect(humanizeError("ERROR: Requested format is not available")).toMatch(/ссылк/i);
  });
});

describe("classifyError", () => {
  it("относит новые сигнатуры к нужному типу CTA", () => {
    expect(classifyError("ERROR: HTTP Error 429: Too Many Requests")).toBe("network");
    expect(classifyError("ERROR: HTTP Error 403: Forbidden")).toBe("network");
    expect(classifyError("ERROR: nsig extraction failed")).toBe("unsupported");
    expect(classifyError("ERROR: unable to extract player response")).toBe("unsupported");
    expect(classifyError("DRM:netflix")).toBe("drm");
    expect(classifyError("ERROR: Sign in to confirm you're not a bot")).toBe("auth");
  });
});
