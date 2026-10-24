import type { RoomState } from "./ipc";

/** Разрыв, после которого гость просто перематывается (с), а не догоняет скоростью. */
export const HARD_DRIFT = 0.7;
/** Меньше этого рассинхрон незаметен — скорость не трогаем (с). */
export const SOFT_DRIFT = 0.04;
/** Предел подстройки скорости (±6% — на слух почти не заметно). */
const MAX_RATE_DELTA = 0.06;

export interface SyncStep {
  play: boolean;
  pause: boolean;
  /** Куда перемотать или null. */
  seek: number | null;
  rate: number;
}

/** Где сейчас должен быть плеер по состоянию ведущего (now и at — в одних часах, мс). */
export function expectedPos(s: RoomState, now: number): number {
  return s.playing ? s.pos + ((now - s.at) / 1000) * s.rate : s.pos;
}

/** Один шаг подстройки плеера гостя под ведущего. */
export function syncStep(s: RoomState, now: number, current: number, paused: boolean): SyncStep {
  const expected = Math.max(0, expectedPos(s, now));
  const drift = current - expected;
  if (!s.playing) {
    // На паузе выравниваем точнее: стоп-кадр у всех должен совпадать.
    return { play: false, pause: !paused, seek: Math.abs(drift) > 0.12 ? expected : null, rate: s.rate };
  }
  if (Math.abs(drift) > HARD_DRIFT) {
    return { play: paused, pause: false, seek: expected, rate: s.rate };
  }
  // Впереди — чуть медленнее, отстаём — чуть быстрее; пропорционально разрыву.
  const delta = Math.abs(drift) > SOFT_DRIFT ? Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, drift * 0.5)) : 0;
  return { play: paused, pause: false, seek: null, rate: s.rate * (1 - delta) };
}
