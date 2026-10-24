import { LOGO_MARK } from "../lib/appIcon";

/** Экран запуска: знак Mestia на плитке акцента (тот же, что в иконке и боковой панели). */
export default function Splash({ fading }: { fading: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-snow transition-opacity duration-500 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <span className="mestia-splash-badge relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-[20px] bg-accent shadow-lg">
        <svg
          viewBox="0 0 256 256"
          className="mestia-splash-mark h-[60px] w-[60px] text-white"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: LOGO_MARK }}
        />
      </span>

      <span className="mestia-splash-word bg-gradient-to-r from-ink to-accent bg-clip-text text-3xl font-bold tracking-tight text-transparent">
        Mestia
      </span>

      <div className="mestia-splash-word h-1 w-40 overflow-hidden rounded-full bg-fog">
        <div className="mestia-splash-fill h-full w-1/3 rounded-full bg-accent" />
      </div>
    </div>
  );
}
