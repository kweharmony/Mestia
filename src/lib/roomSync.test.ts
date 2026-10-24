import { describe, expect, it } from "vitest";
import { expectedPos, syncStep } from "./roomSync";

const state = (over = {}) => ({ playing: true, pos: 10, rate: 1, at: 1000, peers: 2, ...over });

describe("expectedPos", () => {
  it("идёт вперёд, пока играет", () => {
    expect(expectedPos(state(), 3000)).toBeCloseTo(12);
    expect(expectedPos(state({ rate: 2 }), 3000)).toBeCloseTo(14);
  });
  it("стоит на паузе", () => {
    expect(expectedPos(state({ playing: false }), 9000)).toBe(10);
  });
});

describe("syncStep", () => {
  it("крупный разрыв — перемотка и запуск", () => {
    const s = syncStep(state(), 3000, 5, true);
    expect(s.seek).toBeCloseTo(12);
    expect(s.play).toBe(true);
  });
  it("мелкий разрыв — подстройка скорости", () => {
    expect(syncStep(state(), 3000, 12.2, false).rate).toBeLessThan(1); // впереди
    expect(syncStep(state(), 3000, 11.8, false).rate).toBeGreaterThan(1); // отстаём
    expect(syncStep(state(), 3000, 12.2, false).seek).toBeNull();
  });
  it("в пределах допуска — без изменений", () => {
    const s = syncStep(state(), 3000, 12.01, false);
    expect(s.rate).toBe(1);
    expect(s.play || s.pause).toBe(false);
  });
  it("пауза ведущего — пауза и выравнивание позиции", () => {
    const s = syncStep(state({ playing: false }), 3000, 14, false);
    expect(s.pause).toBe(true);
    expect(s.seek).toBe(10);
  });
});
