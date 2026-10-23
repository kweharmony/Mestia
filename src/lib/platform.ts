// Платформа, на которой запущен интерфейс. На Android нет трея, проводника,
// отдельных окон, куки браузеров и самоудаления — такие элементы UI скрываются.

export const IS_ANDROID = /Android/i.test(navigator.userAgent);

/** Первая http(s)-ссылка в тексте («Поделиться» из приложений часто шлёт «Название https://…»). */
export function extractUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+/i)?.[0] ?? null;
}
