import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  estimateAudioBytes,
  formatBytes,
  formatDuration,
  formatSpeed,
  isAudioPath,
} from "./ipc";

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
  });

  it("null для неизвестного пресета или пустой длительности", () => {
    expect(estimateAudioBytes(60, "flac")).toBeNull();
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
