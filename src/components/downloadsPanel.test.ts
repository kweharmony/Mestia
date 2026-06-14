import { describe, expect, it } from "vitest";
import { overallPercent } from "./DownloadsPanel";
import type { ActiveDownload } from "../context/DownloadsContext";

function make(p: Partial<ActiveDownload>): ActiveDownload {
  return {
    id: "x",
    title: "t",
    isPlaylist: false,
    percent: 0,
    index: null,
    totalItems: null,
    doneCount: 0,
    status: "downloading",
    ...p,
  };
}

describe("overallPercent", () => {
  it("одиночное видео — отдаёт собственный процент", () => {
    expect(overallPercent(make({ percent: 42 }))).toBe(42);
  });

  it("плейлист — агрегат по готовым + доля текущего", () => {
    // 2-е из 4 видео на 50% → (1 + 0.5) / 4 = 37.5%
    const d = make({ isPlaylist: true, totalItems: 4, index: 2, percent: 50 });
    expect(overallPercent(d)).toBeCloseTo(37.5);
  });

  it("плейлист без index — опирается на doneCount", () => {
    // 2 готовых из 5, текущее на 0% → 40%
    const d = make({ isPlaylist: true, totalItems: 5, index: null, doneCount: 2, percent: 0 });
    expect(overallPercent(d)).toBeCloseTo(40);
  });

  it("плейлист без totalItems — падает обратно на percent", () => {
    expect(overallPercent(make({ isPlaylist: true, totalItems: null, percent: 12 }))).toBe(12);
  });

  it("не превышает 100%", () => {
    const d = make({ isPlaylist: true, totalItems: 2, index: 2, percent: 100 });
    expect(overallPercent(d)).toBe(100);
  });
});
