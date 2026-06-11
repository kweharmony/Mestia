/**
 * Логотип Mestia: акцентный «лоток загрузки» с анимированной стрелкой,
 * которая ритмично «падает» в основание — намёк на скачивание.
 */
export default function Logo() {
  return (
    <div className="mestia-logo flex items-center gap-2.5 px-2 no-select">
      <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-accent shadow-sm">
        {/* падающая стрелка */}
        <svg
          viewBox="0 0 24 24"
          className="mestia-logo-arrow h-4 w-4"
          fill="none"
          stroke="white"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 v10 M7 10 l5 5 5-5" />
        </svg>
        {/* основание (лоток) */}
        <span className="absolute bottom-[5px] h-[2.5px] w-3.5 rounded-full bg-white/90" />
      </span>
      <span className="bg-gradient-to-r from-ink to-accent bg-clip-text text-lg font-bold tracking-tight text-transparent">
        Mestia
      </span>
    </div>
  );
}
