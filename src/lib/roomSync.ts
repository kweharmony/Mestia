import type { RoomState } from "./ipc";

/** Разрыв, после которого гость просто перематывается (с), а не догоняет скоростью. */
export const HARD_DRIFT = 0.7;
/** Меньше этого рассинхрон незаметен — скорость не трогаем (с). */
export const SOFT_DRIFT = 0.025;
/** Предел подстройки скорости (±10%; высота звука сохраняется — preservesPitch). */
const MAX_RATE_DELTA = 0.1;
/** play() начинает звучать не сразу — стартуем с упреждением (начальная оценка, с). */
export const PLAY_LEAD = 0.1;
/** На паузе стоп-кадр должен совпадать точнее, чем «на ходу» (с). */
const PAUSE_DRIFT = 0.04;

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
export function syncStep(
  s: RoomState,
  now: number,
  current: number,
  paused: boolean,
  lead = PLAY_LEAD
): SyncStep {
  const expected = Math.max(0, expectedPos(s, now));
  const drift = current - expected;
  if (!s.playing) {
    // На паузе выравниваем точнее: стоп-кадр у всех должен совпадать.
    return { play: false, pause: !paused, seek: Math.abs(drift) > PAUSE_DRIFT ? expected : null, rate: s.rate };
  }
  // Запуск после паузы/смены файла: сразу в точку с упреждением на время старта play().
  if (paused) {
    return { play: true, pause: false, seek: Math.abs(drift) > SOFT_DRIFT ? expected + lead : null, rate: s.rate };
  }
  if (Math.abs(drift) > HARD_DRIFT) {
    return { play: false, pause: false, seek: expected, rate: s.rate };
  }
  // Впереди — чуть медленнее, отстаём — чуть быстрее; пропорционально разрыву.
  const delta = Math.abs(drift) > SOFT_DRIFT ? Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, drift * 0.8)) : 0;
  return { play: false, pause: false, seek: null, rate: s.rate * (1 - delta) };
}

/**
 * Новое упреждение старта по промаху прошлого: drift — насколько гость оказался впереди
 * (+) или позади (−) ведущего вскоре после запуска. Время старта play() своё у каждого
 * устройства и формата, поэтому подстраиваемся, а не угадываем.
 */
export function nextLead(lead: number, drift: number): number {
  return Math.max(0, Math.min(0.4, lead - drift));
}
